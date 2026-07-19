// The autonomous supervising loop (#5135, Wave 3.5): the missing daemon/watch layer over the one-shot
// `discover`/`attempt` subcommands. Every existing piece it composes -- runDiscover, runAttempt,
// evaluateRunLoopBoundaryGate, attemptLoopReentry, buildLoopClosureSummary, governor-state.js -- already
// existed; this is the first caller that actually chains them into a real repeat-until-halted run.
//
// STRUCTURE (one cycle): kill-switch check -> pause-flag check (#4851, governor-state.js's persisted
// paused/reason/pausedAt) -> real-per-repo-policy-aware run-loop boundary gate (before claiming) -> real
// runAttempt -> real CI-status poll (ci-poller.js, #5394) + real PR-disposition poll
// (pr-disposition-poller.js, on a submitted outcome) -> real loop-closure summary -> real attemptLoopReentry
// decision. `attemptLoopReentry`'s own dequeue is the
// AUTHORITATIVE claim for every cycle after the first (its own doc: "if allowed -- dequeues the next
// candidate") -- this loop does not ALSO call portfolioQueue.dequeueNext() on a successful reentry, which
// would silently double-claim (the reentry's own claim would then leak as a permanently 'in_progress', never-
// attempted row). A manual dequeueNext() is used only to prime the very first cycle (no prior outcome exists
// yet to reenter from) and to refill after an empty queue.
//
// REAL, NOT FABRICATED: this loop is the first production caller of governor-state.js's `saveCapUsage`
// (turnsTaken from runMinerAttempt's own real `loopResult.totalTurnsUsed`, elapsedMs from real wall-clock
// measurement). Its per-identifier convergence history (attempts/consecutiveFailures/reenqueues) is the real,
// SQLite-persisted portfolio-queue attempt-history (portfolio-queue.js's getAttemptHistory, #5654) that the
// dequeueNext claim + markDone/markFailed calls below already maintain -- the same source a one-shot `attempt`
// invocation reads (#5654), so both share one source of truth and the counters survive a loop-daemon restart
// (crash/deploy/systemd bounce) instead of resetting with the process (#5677).
import { checkMinerKillSwitch } from "./governor-kill-switch.js";
import { argsWantJson, describeCliError, reportCliFailure } from "./cli-error.js";
import { evaluateRunLoopBoundaryGate } from "./governor-run-halt.js";
import { openGovernorState } from "./governor-state.js";
import { initGovernorLedger } from "./governor-ledger.js";
import { initEventLedger } from "./event-ledger.js";
import { initPortfolioQueueStore } from "./portfolio-queue.js";
import { initRunStateStore } from "./run-state.js";
import { runDiscover } from "./discover-cli.js";
import { runAttempt } from "./attempt-cli.js";
import { resolveAmsPolicy } from "./ams-policy.js";
import { pollPrDisposition, classifyPrDisposition } from "./pr-disposition-poller.js";
import { pollCheckRuns } from "./ci-poller.js";
import { recordPrOutcomeSnapshot } from "./pr-outcome.js";
import { isRejectedPr } from "./rejection-state-machine.js";
import { buildLoopClosureSummary } from "./loop-closure.js";
import { attemptLoopReentry } from "./loop-reentry.js";
import { parsePrNumberFromExecResult } from "./pr-number-parse.js";
import { resolveGitHubToken } from "./github-token-resolution.js";
import { DEFAULT_AMS_POLICY_SPEC } from "@loopover/engine";
const LOOP_USAGE = "Usage: loopover-miner loop <owner/repo> [<owner/repo>...] | --search <query> --miner-login <login> [--base <branch>] [--live] [--dry-run] [--max-cycles <n>] [--cycle-delay-ms <ms>] [--json]";
const DEFAULT_CYCLE_DELAY_MS = 60_000;
const ISSUE_IDENTIFIER_PATTERN = /^issue:(\d+)$/;
function parseRepoTarget(value) {
    const trimmed = typeof value === "string" ? value.trim() : "";
    const [owner, repo, extra] = trimmed.split("/");
    if (!owner || !repo || extra !== undefined)
        return null;
    return `${owner}/${repo}`;
}
function normalizeOptionalPositiveInt(value, label) {
    const parsedValue = Number(value);
    if (!Number.isFinite(parsedValue) || !Number.isInteger(parsedValue) || parsedValue < 0) {
        throw new Error(`${label} must be a non-negative integer: ${value}`);
    }
    return parsedValue;
}
export function parseLoopArgs(args) {
    const options = {
        json: false,
        minerLogin: null,
        base: "main",
        live: false,
        dryRun: false,
        search: null,
        maxCycles: undefined,
        cycleDelayMs: DEFAULT_CYCLE_DELAY_MS,
    };
    const targets = [];
    for (let index = 0; index < args.length; index += 1) {
        const token = args[index];
        if (token === "--json") {
            options.json = true;
            continue;
        }
        if (token === "--live") {
            options.live = true;
            continue;
        }
        // #4847: see attempt-cli.js's own --dry-run comment -- distinct from --live's absence, this short-circuits
        // BEFORE governor state or any other store is opened, guaranteeing zero discovery/queue/ledger writes.
        if (token === "--dry-run") {
            options.dryRun = true;
            continue;
        }
        if (token === "--search") {
            const value = args[index + 1];
            if (!value || value.startsWith("-"))
                return { error: LOOP_USAGE };
            options.search = value;
            index += 1;
            continue;
        }
        if (token === "--miner-login") {
            const value = args[index + 1];
            if (!value || value.startsWith("-"))
                return { error: LOOP_USAGE };
            options.minerLogin = value;
            index += 1;
            continue;
        }
        if (token === "--base") {
            const value = args[index + 1];
            if (!value || value.startsWith("-"))
                return { error: LOOP_USAGE };
            options.base = value;
            index += 1;
            continue;
        }
        if (token === "--max-cycles") {
            const value = args[index + 1];
            if (!value || value.startsWith("-"))
                return { error: LOOP_USAGE };
            try {
                options.maxCycles = normalizeOptionalPositiveInt(value, "--max-cycles");
            }
            catch (error) {
                return { error: error instanceof Error ? error.message : String(error) };
            }
            index += 1;
            continue;
        }
        if (token === "--cycle-delay-ms") {
            const value = args[index + 1];
            if (!value || value.startsWith("-"))
                return { error: LOOP_USAGE };
            try {
                options.cycleDelayMs = normalizeOptionalPositiveInt(value, "--cycle-delay-ms");
            }
            catch (error) {
                return { error: error instanceof Error ? error.message : String(error) };
            }
            index += 1;
            continue;
        }
        if (token.startsWith("-"))
            return { error: `Unknown option: ${token}` };
        const target = parseRepoTarget(token);
        if (!target)
            return { error: `Repository must be in owner/repo form: ${token}` };
        targets.push(target);
    }
    if (options.search === null && targets.length === 0)
        return { error: LOOP_USAGE };
    if (options.search !== null && targets.length > 0)
        return { error: "Pass either repository targets or --search, not both." };
    if (!options.minerLogin)
        return { error: `--miner-login is required. ${LOOP_USAGE}` };
    return {
        targets,
        search: options.search,
        minerLogin: options.minerLogin,
        base: options.base,
        live: options.live,
        dryRun: options.dryRun,
        maxCycles: options.maxCycles,
        cycleDelayMs: options.cycleDelayMs,
        json: options.json,
    };
}
function discoverArgv(parsed) {
    return parsed.search !== null ? ["--search", parsed.search] : [...parsed.targets];
}
function parseIssueNumberFromIdentifier(identifier) {
    const match = typeof identifier === "string" ? identifier.match(ISSUE_IDENTIFIER_PATTERN) : null;
    return match ? Number(match[1]) : null;
}
/**
 * Run one full discover -> claim -> attempt -> observe -> reenter cycle repeatedly until a kill-switch trips,
 * the run-loop boundary gate halts (non-convergence or a real budget/turn/elapsed cap), re-entry is declined,
 * or `--max-cycles` is reached. Fails closed: refuses to start at all if governor state cannot be loaded.
 */
export async function runLoop(args, options = {}) {
    const parsed = parseLoopArgs(args);
    if ("error" in parsed) {
        return reportCliFailure(argsWantJson(args), parsed.error);
    }
    // Narrow for nested closures (TS resets control-flow narrowing inside nested functions).
    const loopArgs = parsed;
    const env = options.env ?? process.env;
    const sleepFn = options.sleepFn ?? ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)));
    const nowMsFn = () => options.nowMs ?? Date.now();
    const sessionStartMs = nowMsFn();
    // #4847: reports what a real loop invocation would target and returns BEFORE governor state or any other
    // store (event/governor ledger, portfolio queue, run state) is opened -- a provable zero-write path, not just
    // "opened but didn't write." The loop's own discovery call enqueues newly-found candidates into the LOCAL
    // portfolio queue even before any attempt happens, so a faithful dry run cannot call it either.
    if (parsed.dryRun) {
        const dryRunResult = {
            outcome: "dry_run",
            targets: parsed.targets,
            search: parsed.search,
            minerLogin: parsed.minerLogin,
            base: parsed.base,
            live: parsed.live,
            maxCycles: parsed.maxCycles ?? null,
        };
        if (parsed.json) {
            console.log(JSON.stringify(dryRunResult, null, 2));
        }
        else {
            const target = parsed.search !== null ? `--search ${parsed.search}` : parsed.targets.join(", ");
            console.log(`DRY RUN: would run an autonomous loop against ${target} for ${parsed.minerLogin} (base: ${parsed.base}, live: ${parsed.live}). No discovery, queue, or ledger writes were made.`);
        }
        return 0;
    }
    let governorState;
    try {
        governorState = (options.openGovernorState ?? openGovernorState)();
    }
    catch (error) {
        return reportCliFailure(parsed.json, `Loop refuses to start: governor state cannot be loaded: ${describeCliError(error)}`, 3);
    }
    const eventLedger = (options.initEventLedger ?? initEventLedger)();
    const governorLedger = (options.initGovernorLedger ?? initGovernorLedger)();
    const portfolioQueue = (options.initPortfolioQueue ?? initPortfolioQueueStore)();
    const runState = (options.initRunStateStore ?? initRunStateStore)();
    const runDiscoverFn = options.runDiscover ?? runDiscover;
    const runAttemptFn = options.runAttempt ?? runAttempt;
    const resolveAmsPolicyFn = options.resolveAmsPolicy ?? resolveAmsPolicy;
    const checkKillSwitchFn = options.checkMinerKillSwitch ?? checkMinerKillSwitch;
    const evaluateBoundaryGateFn = options.evaluateRunLoopBoundaryGate ?? evaluateRunLoopBoundaryGate;
    const pollPrDispositionFn = options.pollPrDisposition ?? pollPrDisposition;
    const pollCheckRunsFn = options.pollCheckRuns ?? pollCheckRuns;
    const recordPrOutcomeSnapshotFn = options.recordPrOutcomeSnapshot ?? recordPrOutcomeSnapshot;
    const buildLoopClosureSummaryFn = options.buildLoopClosureSummary ?? buildLoopClosureSummary;
    const attemptLoopReentryFn = options.attemptLoopReentry ?? attemptLoopReentry;
    // Resolved ONCE, at the CLI-entrypoint layer, mirroring manage-poll.js's own runManagePoll (its
    // recordManagePollSnapshot callee has no env fallback of its own either -- the top-level CLI function is
    // where the GitHub token gets resolved, then threaded down explicitly to every real GitHub caller).
    // pollPrDisposition (unlike runDiscover, which falls back to process.env.GITHUB_TOKEN internally) has NO
    // such fallback -- an unresolved githubToken here would silently poll unauthenticated.
    // resolveGitHubToken (#6116): GITHUB_TOKEN env override wins outright, else a live token from the
    // authenticated `loopover-mcp login` session -- cached in memory for this process's lifetime.
    const githubToken = options.githubToken ?? (await resolveGitHubToken(env)) ?? "";
    async function runDiscoveryOnce() {
        await runDiscoverFn(discoverArgv(loopArgs), {
            initPortfolioQueue: () => portfolioQueue,
            githubToken,
            ...(options.apiBaseUrl !== undefined ? { apiBaseUrl: options.apiBaseUrl } : {}),
            nowMs: nowMsFn(),
        });
    }
    let usage = governorState.loadCapUsage();
    const cycles = [];
    let sinceSeq = eventLedger.readEvents({}).at(-1)?.seq ?? 0;
    let haltReason = null;
    try {
        // Checked BEFORE any work at all -- including the very first discovery call -- so an already-active kill
        // switch OR an already-active pause (#4851) halts the loop without ever touching GitHub or the queue. The
        // pause flag is real, persisted, operator/governor-writable state on governorState (toggled via
        // `loopover-miner governor pause`/`resume`) -- unlike the kill switch, a paused run resumes simply by being
        // re-invoked: every piece of per-cycle state this loop reads (portfolioQueue, runState, governorState's own
        // cap usage) is already durable, so clearing the flag and restarting continues exactly where it left off.
        const initialKillSwitch = checkKillSwitchFn({ env });
        const initialPauseState = governorState.loadPauseState();
        let claimed = null;
        if (initialKillSwitch.active) {
            haltReason = `kill_switch_${initialKillSwitch.scope}`;
            cycles.push({ cycle: 1, outcome: "halted", reason: haltReason });
        }
        else if (initialPauseState.paused) {
            haltReason = "paused";
            cycles.push({ cycle: 1, outcome: "halted", reason: haltReason });
        }
        else {
            await runDiscoveryOnce();
            claimed = portfolioQueue.dequeueNext();
        }
        let cycleIndex = haltReason !== null ? 1 : 0;
        while (haltReason === null && (parsed.maxCycles === undefined || cycleIndex < parsed.maxCycles)) {
            cycleIndex += 1;
            const killSwitch = checkKillSwitchFn({ env });
            if (killSwitch.active) {
                haltReason = `kill_switch_${killSwitch.scope}`;
                // Release the in-flight claim so left state is defined (#5670 / mirrors run-halt's markFailed).
                if (claimed) {
                    portfolioQueue.markFailed(claimed.repoFullName, claimed.identifier, claimed.apiBaseUrl);
                }
                cycles.push({
                    cycle: cycleIndex,
                    outcome: "halted",
                    reason: haltReason,
                    ...(claimed
                        ? { repoFullName: claimed.repoFullName, identifier: claimed.identifier }
                        : {}),
                });
                break;
            }
            const pauseState = governorState.loadPauseState();
            if (pauseState.paused) {
                haltReason = "paused";
                if (claimed) {
                    portfolioQueue.markFailed(claimed.repoFullName, claimed.identifier, claimed.apiBaseUrl);
                }
                cycles.push({
                    cycle: cycleIndex,
                    outcome: "halted",
                    reason: haltReason,
                    ...(claimed
                        ? { repoFullName: claimed.repoFullName, identifier: claimed.identifier }
                        : {}),
                });
                break;
            }
            if (!claimed) {
                cycles.push({ cycle: cycleIndex, outcome: "idle_queue_empty" });
                await sleepFn(parsed.cycleDelayMs);
                await runDiscoveryOnce();
                claimed = portfolioQueue.dequeueNext();
                continue;
            }
            const issueNumber = parseIssueNumberFromIdentifier(claimed.identifier);
            if (issueNumber === null) {
                // Never produced by enqueueRankedDiscovery in practice (always "issue:N") -- fail soft rather than
                // crash the whole run: this exact item can never be attempted, so it will never resolve on retry.
                portfolioQueue.markDone(claimed.repoFullName, claimed.identifier, claimed.apiBaseUrl);
                cycles.push({ cycle: cycleIndex, outcome: "skipped_malformed_identifier", identifier: claimed.identifier });
                claimed = portfolioQueue.dequeueNext();
                continue;
            }
            // Capture for the boundary-gate markFailed callback (claimed is reassigned later in the loop).
            const claimedEntry = claimed;
            const amsPolicy = await resolveAmsPolicyFn(claimedEntry.repoFullName, { env });
            // Real, SQLite-persisted per-item convergence history (#5677): the dequeueNext claim above already recorded
            // this attempt and the markDone/markFailed calls below record the outcome, so reading it back here shares one
            // source of truth with attempt-cli.js (#5654) and survives a loop-daemon restart instead of resetting.
            const convergenceInput = portfolioQueue.getAttemptHistory(claimedEntry.repoFullName, claimedEntry.identifier, claimedEntry.apiBaseUrl);
            const boundary = evaluateBoundaryGateFn({
                runHalted: false,
                usage,
                // RunLoopOptions.resolveAmsPolicy types spec as Record<string, unknown> (pre-existing .d.ts);
                // real resolveAmsPolicy returns AmsPolicySpec — cast preserves runtime fallback behavior.
                limits: amsPolicy.spec.capLimits ?? DEFAULT_AMS_POLICY_SPEC.capLimits,
                convergence: convergenceInput,
                convergenceThresholds: amsPolicy.spec.convergenceThresholds ??
                    DEFAULT_AMS_POLICY_SPEC.convergenceThresholds,
                inFlightItem: { repoFullName: claimedEntry.repoFullName, identifier: claimedEntry.identifier },
                // Echoes claimed.apiBaseUrl (#5563), NOT the callback's own repoFullName/identifier alone -- two forge
                // hosts can share an in-flight item with the same repo name+identifier.
                markFailed: (repoFullName, identifier) => portfolioQueue.markFailed(repoFullName, identifier, claimedEntry.apiBaseUrl),
            }, { append: (event) => governorLedger.appendGovernorEvent(event) });
            if (!boundary.canClaimNext) {
                haltReason = `boundary_${boundary.verdict.reason}`;
                cycles.push({ cycle: cycleIndex, outcome: "halted", reason: haltReason, repoFullName: claimedEntry.repoFullName, identifier: claimedEntry.identifier });
                break;
            }
            const cycleStartMs = nowMsFn();
            // Local result bag: AttemptCliResult is a discriminant union; CFA after the onResult callback
            // collapses typed bags to `never`, so keep this local untyped (runtime shape unchanged).
            let lastResult = null;
            const attemptArgv = [
                claimedEntry.repoFullName,
                String(issueNumber),
                "--miner-login",
                parsed.minerLogin,
                "--base",
                parsed.base,
                ...(parsed.live ? ["--live"] : []),
            ];
            await runAttemptFn(attemptArgv, {
                ...(options.attemptOptions ?? {}),
                env,
                onResult: (result) => {
                    lastResult = result;
                },
            });
            const cycleElapsedMs = nowMsFn() - cycleStartMs;
            usage = {
                // Real for the agent-sdk provider (its own SDK result message reports total_cost_usd, wired through
                // runMinerAttempt's real loopResult.totalCostUsd); the CLI-subprocess providers (claude-cli/codex-cli)
                // report no cost signal today, so this contributes 0 for those runs -- an honest absence, not a
                // fabricated number. A capLimits.budget dimension only ever meaningfully trips against agent-sdk spend.
                budgetSpent: usage.budgetSpent + (lastResult?.totalCostUsd ?? 0),
                turnsTaken: usage.turnsTaken + (lastResult?.totalTurnsUsed ?? 0),
                elapsedMs: usage.elapsedMs + cycleElapsedMs,
            };
            governorState.saveCapUsage(usage);
            const attemptOutcome = lastResult?.outcome ?? "attempt_error";
            const submitted = attemptOutcome === "attempt_submitted";
            // A repo-wide AI-usage-policy ban will never resolve on retry -- stop re-queuing it (matches
            // rejection-signal.js's own "this repo bans automated contributions" semantics). Every other blocked/
            // abandoned/stale/governed outcome MAY resolve on a later retry (transient infra, contention, a
            // different iteration budget) and is requeued -- a genuinely stuck item is caught by non-convergence
            // (reenqueues threshold) rather than silently retried forever.
            const permanentBlock = attemptOutcome === "blocked_rejection_signaled";
            // Mid-attempt kill-switch abandon (#5670): stop the outer loop immediately instead of waiting for the
            // next between-cycle probe, and treat the item like any other re-queued abandon via markFailed below.
            const killSwitchAbandon = lastResult?.abandonReason === "kill_switch_engaged";
            if (submitted || permanentBlock) {
                // Both terminal -- a submitted PR is done, and a repo-wide AI-usage-policy ban never resolves on retry --
                // so neither is re-queued. markDone also clears the persisted consecutive-failure streak.
                portfolioQueue.markDone(claimedEntry.repoFullName, claimedEntry.identifier, claimedEntry.apiBaseUrl);
            }
            else {
                // Any other blocked/abandoned/stale/governed outcome may resolve on a later retry, so requeue it; markFailed
                // records the re-enqueue + consecutive failure the non-convergence detector reads on the next cycle.
                portfolioQueue.markFailed(claimedEntry.repoFullName, claimedEntry.identifier, claimedEntry.apiBaseUrl);
            }
            if (killSwitchAbandon) {
                const liveKill = checkKillSwitchFn({ env });
                haltReason = liveKill.active ? `kill_switch_${liveKill.scope}` : "kill_switch_engaged";
                cycles.push({
                    cycle: cycleIndex,
                    outcome: "halted",
                    reason: haltReason,
                    repoFullName: claimedEntry.repoFullName,
                    identifier: claimedEntry.identifier,
                    attemptOutcome,
                });
                break;
            }
            let reentryOutcome = "other";
            let prNumber = null;
            let prDisposition = null;
            let ciConclusion = null;
            if (submitted) {
                prNumber = parsePrNumberFromExecResult(lastResult?.execResult, claimedEntry.repoFullName);
                if (prNumber !== null) {
                    // Real CI-status observation (#5394): recorded BEFORE the disposition poll below, so a submitted
                    // PR's check-run state is captured even while it's still open, not just at its eventual merge/close.
                    // ci-poller.js's real GitHub check-run polling is a heuristic proxy for the gate verdict; the
                    // authoritative terminal merge/close outcome comes from pollPrDispositionFn below, sourced directly
                    // from GitHub's own PR state rather than a server-internal endpoint (#5450).
                    const ciStatus = await pollCheckRunsFn(claimedEntry.repoFullName, prNumber, {
                        githubToken,
                        ...(options.apiBaseUrl !== undefined ? { apiBaseUrl: options.apiBaseUrl } : {}),
                        ...(options.ciPollOptions ?? {}),
                    });
                    ciConclusion = ciStatus.conclusion;
                    eventLedger.appendEvent({
                        type: "ci_status_observed",
                        repoFullName: claimedEntry.repoFullName,
                        payload: { prNumber, conclusion: ciStatus.conclusion, checkCount: ciStatus.checks.length, source: "ci-poller" },
                    });
                    prDisposition = await pollPrDispositionFn(claimedEntry.repoFullName, prNumber, {
                        githubToken,
                        ...(options.apiBaseUrl !== undefined ? { apiBaseUrl: options.apiBaseUrl } : {}),
                        ...(options.prDispositionOptions ?? {}),
                    });
                    if (prDisposition.state === "closed") {
                        recordPrOutcomeSnapshotFn({
                            repoFullName: claimedEntry.repoFullName,
                            prNumber,
                            decision: prDisposition.merged ? "merged" : "closed",
                            closedAt: prDisposition.closedAt,
                        }, { eventLedger });
                        // Real per-repo reputation history (#5675): a resolved terminal outcome updates the decided/unfavorable
                        // counts the Governor's self-reputation throttle reads on this repo's next attempt. `decided` always;
                        // `unfavorable` only on a closed-without-merge (rejection-state-machine.js's isRejectedPr, matching
                        // #5655's own-rejection classification). Forge-scoped by claimed.apiBaseUrl (#5563), like every other
                        // governor-state write here.
                        const priorReputation = governorState.loadReputationHistory(claimed.repoFullName, claimed.apiBaseUrl);
                        governorState.saveReputationHistory(claimed.repoFullName, {
                            decided: priorReputation.decided + 1,
                            unfavorable: priorReputation.unfavorable + (isRejectedPr(prDisposition) ? 1 : 0),
                        }, claimed.apiBaseUrl);
                        reentryOutcome = classifyPrDisposition(prDisposition);
                    }
                }
            }
            const loopSummary = buildLoopClosureSummaryFn({ eventLedger, portfolioQueue, runState }, { sinceSeq, repoFullName: claimed.repoFullName });
            sinceSeq = loopSummary.lastSeq;
            const reentry = attemptLoopReentryFn({ killSwitchScope: killSwitch.scope, repoFullName: claimed.repoFullName, outcome: reentryOutcome }, { eventLedger, portfolioQueue, runState, nowMs: nowMsFn(), sessionStartMs, loopSummary });
            cycles.push({
                cycle: cycleIndex,
                outcome: "attempted",
                repoFullName: claimed.repoFullName,
                identifier: claimed.identifier,
                attemptOutcome,
                reentryOutcome,
                prNumber,
                ciConclusion,
                reentered: reentry.decision.reenter,
                reasons: reentry.decision.reasons,
            });
            if (!reentry.decision.reenter) {
                haltReason = `reentry_declined:${reentry.decision.reasons.join(",")}`;
                break;
            }
            if (reentry.dequeued) {
                // attemptLoopReentry's injectable .d.ts types dequeued.status as string; QueueEntry wants QueueStatus.
                claimed = reentry.dequeued;
                await sleepFn(parsed.cycleDelayMs);
            }
            else {
                await sleepFn(parsed.cycleDelayMs);
                await runDiscoveryOnce();
                claimed = portfolioQueue.dequeueNext();
            }
        }
        if (haltReason === null && parsed.maxCycles !== undefined) {
            haltReason = "max_cycles_reached";
            // The next cycle's item is primed (dequeued → 'in_progress') BEFORE the while-condition re-checks
            // maxCycles -- both at the initial priming above and at each cycle's tail -- so exhausting maxCycles
            // ends the run holding a claim no cycle ever processed. Release it, mirroring the kill-switch/pause
            // halts (#5670): dequeueNext() only pulls 'queued' rows, so an unreleased claim is invisible to every
            // future loop/attempt run until an out-of-band stale-lease sweep reclaims it.
            if (claimed) {
                portfolioQueue.markFailed(claimed.repoFullName, claimed.identifier, claimed.apiBaseUrl);
            }
        }
        const summary = { haltReason, cyclesRun: cycles.length, cycles };
        if (parsed.json) {
            console.log(JSON.stringify(summary, null, 2));
        }
        else {
            console.log(`Loop finished after ${cycles.length} cycle(s): ${haltReason ?? "unknown"}.`);
        }
        return 0;
    }
    catch (error) {
        return reportCliFailure(parsed.json, describeCliError(error));
    }
    finally {
        governorState.close();
        eventLedger.close();
        governorLedger.close();
        portfolioQueue.close();
        runState.close();
    }
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibG9vcC1jbGkuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJsb29wLWNsaS50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQSxzR0FBc0c7QUFDdEcsaUdBQWlHO0FBQ2pHLHlHQUF5RztBQUN6RyxtR0FBbUc7QUFDbkcsRUFBRTtBQUNGLHFHQUFxRztBQUNyRyx5R0FBeUc7QUFDekcscUZBQXFGO0FBQ3JGLDZHQUE2RztBQUM3RyxzREFBc0Q7QUFDdEQscUdBQXFHO0FBQ3JHLDBHQUEwRztBQUMxRyw4R0FBOEc7QUFDOUcsNkdBQTZHO0FBQzdHLDJEQUEyRDtBQUMzRCxFQUFFO0FBQ0YsdUdBQXVHO0FBQ3ZHLDBHQUEwRztBQUMxRyw4R0FBOEc7QUFDOUcsNEdBQTRHO0FBQzVHLCtHQUErRztBQUMvRyw2R0FBNkc7QUFDN0csK0VBQStFO0FBRS9FLE9BQU8sRUFBRSxvQkFBb0IsRUFBRSxNQUFNLDJCQUEyQixDQUFDO0FBQ2pFLE9BQU8sRUFBRSxZQUFZLEVBQUUsZ0JBQWdCLEVBQUUsZ0JBQWdCLEVBQUUsTUFBTSxnQkFBZ0IsQ0FBQztBQUNsRixPQUFPLEVBQUUsMkJBQTJCLEVBQUUsTUFBTSx3QkFBd0IsQ0FBQztBQUNyRSxPQUFPLEVBQUUsaUJBQWlCLEVBQUUsTUFBTSxxQkFBcUIsQ0FBQztBQUV4RCxPQUFPLEVBQUUsa0JBQWtCLEVBQUUsTUFBTSxzQkFBc0IsQ0FBQztBQUUxRCxPQUFPLEVBQUUsZUFBZSxFQUFFLE1BQU0sbUJBQW1CLENBQUM7QUFFcEQsT0FBTyxFQUFFLHVCQUF1QixFQUFFLE1BQU0sc0JBQXNCLENBQUM7QUFFL0QsT0FBTyxFQUFFLGlCQUFpQixFQUFFLE1BQU0sZ0JBQWdCLENBQUM7QUFFbkQsT0FBTyxFQUFFLFdBQVcsRUFBRSxNQUFNLG1CQUFtQixDQUFDO0FBQ2hELE9BQU8sRUFBRSxVQUFVLEVBQUUsTUFBTSxrQkFBa0IsQ0FBQztBQUU5QyxPQUFPLEVBQUUsZ0JBQWdCLEVBQUUsTUFBTSxpQkFBaUIsQ0FB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