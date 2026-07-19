import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { registerCleanupResource } from "./process-lifecycle.js";
import { isProcessAlive } from "./worktree-allocator.js";
// Per-repo base-clone cache (#5132, Wave 3.5 follow-up). packages/loopover-engine/src/miner/
// worktree-allocator.ts's real `addWorktree` primitive (git worktree add -b <branch> <path> <baseBranch>)
// requires an EXISTING git clone to branch off -- it has never been wired into this package because that
// clone-management step didn't exist yet. This module is that step: clone a target repo once, then keep it
// current (fetch + hard-reset to the base branch) on every subsequent attempt, so `addWorktree` always
// branches off real, fresh content. Relies entirely on whatever git/gh credentials are already configured
// on this machine -- same assumption execute-local-write.js's `gh pr create` already makes; this module
// never embeds a token in a clone URL.
const execFileAsync = promisify(execFile);
const DEFAULT_CLONE_DIR_NAME = "repos";
const DEFAULT_BASE_BRANCH = "main";
export function resolveRepoCloneBaseDir(env) {
    const resolvedEnv = env === undefined ? process.env : env;
    const explicitPath = typeof resolvedEnv.LOOPOVER_MINER_REPO_CLONE_DIR === "string" ? resolvedEnv.LOOPOVER_MINER_REPO_CLONE_DIR.trim() : "";
    if (explicitPath)
        return explicitPath;
    const explicitConfigDir = typeof resolvedEnv.LOOPOVER_MINER_CONFIG_DIR === "string" ? resolvedEnv.LOOPOVER_MINER_CONFIG_DIR.trim() : "";
    if (explicitConfigDir)
        return join(explicitConfigDir, DEFAULT_CLONE_DIR_NAME);
    const configHome = typeof resolvedEnv.XDG_CONFIG_HOME === "string" && resolvedEnv.XDG_CONFIG_HOME.trim() ? resolvedEnv.XDG_CONFIG_HOME.trim() : join(homedir(), ".config");
    return join(configHome, "loopover-miner", DEFAULT_CLONE_DIR_NAME);
}
// GitHub owner/repo names are restricted to alphanumerics, hyphens, underscores, and periods, and are never
// exactly "." or ".." -- both are rejected here so a value like "../foo" can't make resolveRepoCloneDir's
// join(cloneBaseDir, owner, repo) escape the intended clone directory (a real path-traversal finding).
// Exported so every other owner/repo parser in this package (#5831) shares this one definition instead of
// duplicating it (cross-repo-evaluation.js) or skipping it entirely (attempt-cli.js, claim-ledger-cli.js,
// event-ledger-cli.js, claim-ledger.js).
export const REPO_SEGMENT_PATTERN = /^[A-Za-z0-9._-]+$/;
export function isPathTraversalSegment(segment) {
    return segment === "." || segment === "..";
}
export function isValidRepoSegment(segment) {
    return typeof segment === "string" && REPO_SEGMENT_PATTERN.test(segment) && !isPathTraversalSegment(segment);
}
// Reject values that git would interpret as options when passed as argv (e.g. `--upload-pack=...`).
function isUnsafeGitArgValue(value) {
    return typeof value === "string" && value.startsWith("-");
}
function normalizeRepoFullName(repoFullName) {
    if (typeof repoFullName !== "string")
        throw new Error("invalid_repo_full_name");
    const [owner, repo, extra] = repoFullName.trim().split("/");
    if (!owner || !repo || extra !== undefined)
        throw new Error("invalid_repo_full_name");
    if (!isValidRepoSegment(owner) || !isValidRepoSegment(repo))
        throw new Error("invalid_repo_full_name");
    return { owner, repo, repoFullName: `${owner}/${repo}` };
}
export function resolveRepoCloneDir(repoFullName, env) {
    const target = normalizeRepoFullName(repoFullName);
    return join(resolveRepoCloneBaseDir(env), target.owner, target.repo);
}
async function defaultRunGit(args, cwd, timeoutMs) {
    try {
        const { stdout, stderr } = await execFileAsync("git", args, { cwd, timeout: timeoutMs });
        return { ok: true, stdout: stdout, stderr: stderr };
    }
    catch (error) {
        const err = error;
        const stderr = typeof err?.stderr === "string" ? err.stderr : "";
        return { ok: false, stdout: "", stderr: stderr || (error instanceof Error ? error.message : String(error)) };
    }
}
// Per-repoPath in-process serialization for ensureRepoCloned (#6762). Two attempts for the SAME repo share
// one deterministic base-clone path and mutate it in place (git fetch/checkout/reset --hard); worktree-
// allocator.js only caps the TOTAL active-slot count, never per-repo exclusivity, so without this two
// same-repo attempts can interleave git subprocesses on the same .git dir and corrupt the index/HEAD/refs or
// trip .git/index.lock. `repoCloneLocks` maps a resolved repoPath to the tail of its in-flight promise chain:
// same-repo calls run strictly one after another, while different repoPaths stay fully parallel. The tail
// promise's handlers swallow, so it never rejects -- one failing attempt can neither reject a waiter nor
// wedge the queue -- and the finally drops the entry once the chain drains, keeping the Map bounded.
const repoCloneLocks = new Map();
/** Run `fn` under the in-process per-`repoPath` mutex (critical section = one ensureRepoClonedUnlocked). */
async function withRepoCloneLock(repoPath, fn) {
    const previous = repoCloneLocks.get(repoPath) ?? Promise.resolve();
    const run = previous.then(() => fn());
    const tail = run.then(() => { }, () => { });
    repoCloneLocks.set(repoPath, tail);
    try {
        return await run;
    }
    finally {
        if (repoCloneLocks.get(repoPath) === tail)
            repoCloneLocks.delete(repoPath);
    }
}
// Cross-process serialization for ensureRepoCloned (#7084). The in-process `repoCloneLocks` Map above only
// serializes callers sharing one Node event loop; fleet mode (DEPLOYMENT.md) runs multiple SEPARATE processes --
// distinct containers, no shared memory -- against one bind-mounted clone volume, so two of them can still
// interleave git subprocesses on the same .git dir and corrupt the index/HEAD/refs. An OS-level exclusive lockfile
// (open(.., 'wx')) on a deterministic path derived from repoPath closes that gap: create-and-hold is atomic across
// processes, so exactly one holder mutates the clone while a loser waits (bounded) or fails closed. The lock
// records owner pid+host+timestamp so a holder that CRASHES mid-clone doesn't wedge the repo forever -- a same-host
// dead-owner or an over-age lock is reclaimed (mirroring worktree-allocator.js's stale reclaim), and
// registerCleanupResource unlinks it on SIGINT/SIGTERM like this package's other crash-safe resources (#4826).
const DEFAULT_LOCK_TIMEOUT_MS = 10 * 60 * 1000; // comfortably past a slow clone/fetch sequence
const DEFAULT_LOCK_STALE_MS = 15 * 60 * 1000; // a lock older than this is presumed crashed
const DEFAULT_LOCK_POLL_MS = 100;
const defaultLockSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function repoCloneLockPath(repoPath) {
    return `${repoPath}.clone.lock`;
}
/**
 * Decide whether an existing clone lockfile is stale (reclaimable): true when the file is missing or its JSON is
 * unreadable/partial (a crash mid-write), when its owner pid is confirmed dead within the SAME host's namespace,
 * or -- ONLY for an owner this host cannot probe (a different host/container, or a malformed record with no
 * usable pid) -- when it is older than `staleMs`. A same-host owner whose pid IS probeable is judged purely by
 * liveness: a live one is never stale no matter how long its clone legitimately runs (age reclaim there would
 * yank the lock out from under an in-progress clone -- a double-holder bug), and a dead one is stale at once.
 */
export function isRepoCloneLockStale(lockPath, nowMs, staleMs, isAlive = isProcessAlive) {
    let meta;
    try {
        meta = JSON.parse(readFileSync(lockPath, "utf8"));
    }
    catch {
        return true;
    }
    if (!meta || typeof meta !== "object")
        return true;
    const record = meta;
    // Owner we can directly probe (same host, usable pid): trust liveness exclusively -- alive => held (never
    // age-reclaim a still-running local clone), dead => reclaim now. The age backstop below is reserved for an
    // owner whose liveness is genuinely unknowable from here.
    if (record.host === hostname() && Number.isInteger(record.pid)) {
        return !isAlive(record.pid);
    }
    const atMs = Date.parse(record.at);
    if (!Number.isFinite(atMs))
        return true;
    return nowMs - atMs > staleMs;
}
/**
 * Take the cross-process clone lock for `repoPath`, returning an idempotent `release()`. Atomically create-and-holds
 * `${repoPath}.clone.lock` (open .., 'wx'); on contention it reclaims a stale lock (see {@link isRepoCloneLockStale})
 * or waits `lockPollMs` between retries until `lockTimeoutMs` elapses, then throws `repo_clone_lock_timeout` (fail
 * closed). Registered for crash-safe cleanup so a SIGINT/SIGTERM releases it. `nowMs`/`lockSleep`/`isProcessAlive`/
 * `openLock`/`writeLock` are injectable for tests; every real caller relies on the defaults.
 */
export async function acquireRepoCloneLock(repoPath, options = {}) {
    const lockPath = repoCloneLockPath(repoPath);
    const timeoutMs = Number.isFinite(options.lockTimeoutMs) ? options.lockTimeoutMs : DEFAULT_LOCK_TIMEOUT_MS;
    const staleMs = Number.isFinite(options.lockStaleMs) ? options.lockStaleMs : DEFAULT_LOCK_STALE_MS;
    const pollMs = Number.isFinite(options.lockPollMs) ? options.lockPollMs : DEFAULT_LOCK_POLL_MS;
    const now = typeof options.nowMs === "function" ? options.nowMs : Date.now;
    const sleep = typeof options.lockSleep === "function" ? options.lockSleep : defaultLockSleep;
    const isAlive = typeof options.isProcessAlive === "function" ? options.isProcessAlive : isProcessAlive;
    const openLock = typeof options.openLock === "function" ? options.openLock : (path) => openSync(path, "wx", 0o600);
    const writeLock = typeof options.writeLock === "function" ? options.writeLock : (fd, data) => writeSync(fd, data);
    mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });
    const deadline = now() + timeoutMs;
    for (;;) {
        let fd;
        try {
            fd = openLock(lockPath);
        }
        catch (error) {
            const err = error;
            if (!err || err.code !== "EEXIST")
                throw error;
            if (isRepoCloneLockStale(lockPath, now(), staleMs, isAlive)) {
                try {
                    unlinkSync(lockPath);
                }
                catch {
                    // Another waiter reclaimed it first -- just retry the open.
                }
                continue;
            }
            if (now() >= deadline)
                throw new Error("repo_clone_lock_timeout");
            await sleep(pollMs);
            continue;
        }
        // A per-acquire token stamps THIS holder's ownership so release() can prove the on-disk lock is still ours
        // before removing it -- if a peer reclaimed us as stale and re-acquired, the file now carries their token and
        // we must not delete their lock (that would let a third caller double-hold).
        const token = randomUUID();
        try {
            writeLock(fd, JSON.stringify({ pid: process.pid, host: hostname(), at: new Date(now()).toISOString(), token }));
        }
        catch (error) {
            closeSync(fd);
            try {
                unlinkSync(lockPath);
            }
            catch {
                // best-effort cleanup of our own just-created lock
            }
            throw error;
        }
        let released = false;
        let unregister = () => { };
        const release = () => {
            if (released)
                return;
            released = true;
            unregister();
            try {
                closeSync(fd);
            }
            catch {
                // fd already closed
            }
            try {
                // Only remove the lockfile while it still carries OUR token; if a peer reclaimed + re-acquired it, leave
                // their lock intact. A missing/unreadable file just means our lock is already gone -- nothing to do.
                const current = JSON.parse(readFileSync(lockPath, "utf8"));
                if (current && current.token === token)
                    unlinkSync(lockPath);
            }
            catch {
                // lock already removed or unreadable -- nothing of ours to clean up
            }
        };
        unregister = registerCleanupResource(release);
        return release;
    }
}
async function withRepoCloneCrossProcessLock(repoPath, options, fn) {
    const release = await acquireRepoCloneLock(repoPath, options);
    try {
        return await fn();
    }
    finally {
        release();
    }
}
/**
 * Serialize the git mutations of {@link ensureRepoClonedUnlocked} per resolved repo path so concurrent
 * same-repo attempts never race the shared base clone (#6762), while different repos still run in parallel.
 * Resolves the same `repoPath` the unlocked step computes and uses it as the mutex key; throws (before
 * locking) on a malformed `repoFullName`, matching the prior behaviour.
 */
export async function ensureRepoCloned(repoFullName, options = {}) {
    const target = normalizeRepoFullName(repoFullName);
    const cloneBaseDir = typeof options.cloneBaseDir === "string" && options.cloneBaseDir.trim() ? options.cloneBaseDir.trim() : resolveRepoCloneBaseDir(options.env);
    const repoPath = join(cloneBaseDir, target.owner, target.repo);
    // Two nested locks: the in-process Map (#6762) keeps same-process callers cheap and ordered, and the
    // cross-process lockfile (#7084) additionally serializes separate OS processes sharing the clone volume.
    return withRepoCloneLock(repoPath, () => withRepoCloneCrossProcessLock(repoPath, options, () => ensureRepoClonedUnlocked(repoFullName, options)));
}
/**
 * Ensure a real, current local clone of `repoFullName` exists at the deterministic per-repo cache path.
 * First use: `git clone`. Subsequent use: `git fetch origin` + hard-reset the base branch to
 * `origin/<baseBranch>`, so every attempt branches off fresh content, not a stale prior checkout.
 */
async function ensureRepoClonedUnlocked(repoFullName, options = {}) {
    const target = normalizeRepoFullName(repoFullName);
    const baseBranch = typeof options.baseBranch === "string" && options.baseBranch.trim() ? options.baseBranch.trim() : DEFAULT_BASE_BRANCH;
    const cloneBaseDir = typeof options.cloneBaseDir === "string" && options.cloneBaseDir.trim() ? options.cloneBaseDir.trim() : resolveRepoCloneBaseDir(options.env);
    const repoPath = join(cloneBaseDir, target.owner, target.repo);
    const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 120_000;
    const runGit = options.runGit ?? defaultRunGit;
    if (isUnsafeGitArgValue(baseBranch)) {
        return { ok: false, repoPath, error: "invalid_base_branch" };
    }
    if (!existsSync(repoPath)) {
        mkdirSync(join(cloneBaseDir, target.owner), { recursive: true, mode: 0o700 });
        const cloneUrl = typeof options.remoteUrl === "string" && options.remoteUrl.trim() ? options.remoteUrl.trim() : `https://github.com/${target.owner}/${target.repo}.git`;
        if (isUnsafeGitArgValue(cloneUrl)) {
            return { ok: false, repoPath, error: "invalid_remote_url" };
        }
        const cloned = await runGit(["clone", cloneUrl, repoPath], cloneBaseDir, timeoutMs);
        if (!cloned.ok)
            return { ok: false, repoPath, error: cloned.stderr || "git_clone_failed" };
        return { ok: true, repoPath };
    }
    const fetched = await runGit(["fetch", "origin"], repoPath, timeoutMs);
    if (!fetched.ok)
        return { ok: false, repoPath, error: fetched.stderr || "git_fetch_failed" };
    const checkedOut = await runGit(["checkout", baseBranch], repoPath, timeoutMs);
    if (!checkedOut.ok)
        return { ok: false, repoPath, error: checkedOut.stderr || "git_checkout_failed" };
    const reset = await runGit(["reset", "--hard", `origin/${baseBranch}`], repoPath, timeoutMs);
    if (!reset.ok)
        return { ok: false, repoPath, error: reset.stderr || "git_reset_failed" };
    return { ok: true, repoPath };
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoicmVwby1jbG9uZS5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbInJlcG8tY2xvbmUudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUEsT0FBTyxFQUFFLFFBQVEsRUFBRSxNQUFNLG9CQUFvQixDQUFDO0FBQzlDLE9BQU8sRUFBRSxVQUFVLEVBQUUsTUFBTSxhQUFhLENBQUM7QUFDekMsT0FBTyxFQUFFLFNBQVMsRUFBRSxVQUFVLEVBQUUsU0FBUyxFQUFFLFFBQVEsRUFBRSxZQUFZLEVBQUUsVUFBVSxFQUFFLFNBQVMsRUFBRSxNQUFNLFNBQVMsQ0FBQztBQUMxRyxPQUFPLEVBQUUsT0FBTyxFQUFFLFFBQVEsRUFBRSxNQUFNLFNBQVMsQ0FBQztBQUM1QyxPQUFPLEVBQUUsT0FBTyxFQUFFLElBQUksRUFBRSxNQUFNLFdBQVcsQ0FBQztBQUMxQyxPQUFPLEVBQUUsU0FBUyxFQUFFLE1BQU0sV0FBVyxDQUFDO0FBQ3RDLE9BQU8sRUFBRSx1QkFBdUIsRUFBRSxNQUFNLHdCQUF3QixDQUFDO0FBQ2pFLE9BQU8sRUFBRSxjQUFjLEVBQUUsTUFBTSx5QkFBeUIsQ0FBQztBQUV6RCw2RkFBNkY7QUFDN0YsMEdBQTBHO0FBQzFHLHlHQUF5RztBQUN6RywyR0FBMkc7QUFDM0csdUdBQXVHO0FBQ3ZHLDBHQUEwRztBQUMxRyx3R0FBd0c7QUFDeEcsdUNBQXVDO0FBRXZDLE1BQU0sYUFBYSxHQUFHLFNBQVMsQ0FBQyxRQUFRLENBQUMsQ0FBQztBQUMxQyxNQUFNLHNCQUFzQixHQUFHLE9BQU8sQ0FBQztBQUN2QyxNQUFNLG1CQUFtQixHQUFHLE1BQU0sQ0FBQztBQWlDbkMsTUFBTSxVQUFVLHVCQUF1QixDQUFDLEdBQXdDO0lBQzlFLE1BQU0sV0FBVyxHQUFHLEdBQUcsS0FBSyxTQUFTLENBQUMsQ0FBQyxDQUFDLE9BQU8sQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDLEdBQUcsQ0FBQztJQUMxRCxNQUFNLFlBQVksR0FBRyxPQUFPLFdBQVcsQ0FBQyw2QkFB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LEVBQUUsVUFBVSxDQUFDLEVBQUUsUUFBUSxFQUFFLFNBQVMsQ0FBQyxDQUFDO0lBQy9FLElBQUksQ0FBQyxVQUFVLENBQUMsRUFBRTtRQUFFLE9BQU8sRUFBRSxFQUFFLEVBQUUsS0FBSyxFQUFFLFFBQVEsRUFBRSxLQUFLLEVBQUUsVUFBVSxDQUFDLE1BQU0sSUFBSSxxQkFBcUIsRUFBRSxDQUFDO0lBRXRHLE1BQU0sS0FBSyxHQUFHLE1BQU0sTUFBTSxDQUFDLENBQUMsT0FBTyxFQUFFLFFBQVEsRUFBRSxVQUFVLFVBQVUsRUFBRSxDQUFDLEVBQUUsUUFBUSxFQUFFLFNBQVMsQ0FBQyxDQUFDO0lBQzdGLElBQUksQ0FBQyxLQUFLLENBQUMsRUFBRTtRQUFFLE9BQU8sRUFBRSxFQUFFLEVBQUUsS0FBSyxFQUFFLFFBQVEsRUFBRSxLQUFLLEVBQUUsS0FBSyxDQUFDLE1BQU0sSUFBSSxrQkFBa0IsRUFBRSxDQUFDO0lBRXpGLE9BQU8sRUFBRSxFQUFFLEVBQUUsSUFBSSxFQUFFLFFBQVEsRUFBRSxDQUFDO0FBQ2hDLENBQUMifQ==