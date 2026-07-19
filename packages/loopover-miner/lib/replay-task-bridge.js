// Bridge (#6160): turns a frozen replay snapshot (replay-snapshot.js, #3010) into a leakage-safe replay task via
// the leakage-safe generator (replay-task-generation.js, #3011), so the historical-replay calibration flow
// (calibration-run.js, #4248) never scores a task built from historical context that still leaks post-T state.
//
// #3011 shipped the leakage-safe generator (scrub/lint/select/classify + generateReplayTask) with ZERO callers:
// nothing turned a #3010 snapshot into a task, so scrubForwardReferences/lintFrozenContext were never actually run
// on real historical-replay data -- the safety harness sat unused. This module is that missing seam. It reads the
// snapshot's own free-text context (README-at-T, commit subjects, reachable tag names -- the fields a forward
// reference can hide in), derives the leakage context the snapshot already knows (every pre-T commit SHA it
// carries), and hands both to generateReplayTask, which LINTS then SCRUBS the frozen context BEFORE returning a
// task -- exactly #3011's original design intent.
//
// REMAINING GAP (noted honestly, per the issue): the snapshot is git-only, so it cannot know issue numbers.
// `knownIssueMax` / `revealedIssueNumbers` -- the calibration harness's issue-history knowledge -- must be supplied
// by the caller. And the replay EXECUTOR that turns these frozen tasks into the `{ replayPlan, revealedHistory }`
// results calibration-run.js scores is still unbuilt (nothing calls exportReplaySnapshot yet either). This bridge
// wires the two halves that DO exist -- snapshot -> leakage-safe task -- and leaves that executor as the next
// connective step. Every function here is pure and deterministic (no clock, no randomness, no IO).
import { generateReplayScoringKey, generateReplayTask } from "./replay-task-generation.js";
function assertSnapshot(snapshot) {
    if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
        throw new Error("invalid_replay_snapshot");
    }
    return snapshot;
}
function snapshotCommits(snapshot) {
    return Array.isArray(snapshot.commits) ? snapshot.commits : [];
}
// The snapshot's free-text context, in a fixed order: README-at-T, then each commit subject, then each reachable
// tag name. Unlike the structurally pre-T-validated SHAs/dates, these are author-controlled prose where a forward
// reference can hide, so they are exactly what must be scrubbed/linted before a task is frozen. Empty and
// non-string fields are skipped so they never dilute the frozen context.
export function collectFrozenContextTexts(snapshot) {
    assertSnapshot(snapshot);
    const texts = [];
    const readmeContent = snapshot.readme?.content;
    if (typeof readmeContent === "string" && readmeContent.length > 0)
        texts.push(readmeContent);
    for (const commit of snapshotCommits(snapshot)) {
        if (typeof commit?.subject === "string" && commit.subject.length > 0)
            texts.push(commit.subject);
    }
    const tags = Array.isArray(snapshot.tags) ? snapshot.tags : [];
    for (const tag of tags) {
        if (typeof tag?.name === "string" && tag.name.length > 0)
            texts.push(tag.name);
    }
    return texts;
}
// The leakage context #3011's scrubber needs. The pre-T commit SHAs are DERIVED from the snapshot itself (it
// carries the full ancestry up to T), so a snapshot's own commits are never mistaken for forward references;
// the issue-number knowledge the git snapshot cannot hold is passed through from the caller.
export function buildLeakageContextFromSnapshot(snapshot, issueContext = {}) {
    assertSnapshot(snapshot);
    return {
        knownIssueMax: issueContext.knownIssueMax,
        knownCommitShas: snapshotCommits(snapshot).map((commit) => commit?.sha),
        revealedIssueNumbers: issueContext.revealedIssueNumbers,
    };
}
// The freeze-point candidate #3011's selector/generator expect, mapped from the snapshot plus the revealed post-T
// side (commit count + ground truth) the snapshot deliberately does not hold.
export function buildReplayCandidateFromSnapshot(snapshot, revealed = {}) {
    assertSnapshot(snapshot);
    return {
        repo: typeof snapshot.repoFullName === "string" ? snapshot.repoFullName : null,
        commitT: typeof snapshot.commitSha === "string" ? snapshot.commitSha : null,
        lastActivityAt: typeof snapshot.targetDate === "string" ? snapshot.targetDate : null,
        priorCommitCount: snapshotCommits(snapshot).length,
        revealedCommitCount: revealed.revealedCommitCount,
        revealedGroundTruth: revealed.revealedGroundTruth,
        frozenContextTexts: collectFrozenContextTexts(snapshot),
    };
}
// The wiring. Builds the leakage context + candidate from the snapshot, then runs generateReplayTask, which LINTS
// the frozen context (rejecting on any unscrubbable forward reference) and SCRUBS the surviving text before
// returning the frozen task -- so a replay task is never generated from leaky historical context.
export function generateLeakageSafeReplayTask(snapshot, revealed = {}, issueContext = {}, options = {}) {
    const context = buildLeakageContextFromSnapshot(snapshot, issueContext);
    const candidate = buildReplayCandidateFromSnapshot(snapshot, revealed);
    return generateReplayTask(candidate, context, options);
}
// Scoring-only sibling: the isolated post-execution scorer key for the same snapshot. It shares only selection
// eligibility with the task above and never carries frozen context (mirroring #3011's own generate/scoring split),
// so a caller must check generateLeakageSafeReplayTask's own result before treating the two as a matched pair.
export function generateLeakageSafeScoringKey(snapshot, revealed = {}, options = {}) {
    return generateReplayScoringKey(buildReplayCandidateFromSnapshot(snapshot, revealed), options);
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoicmVwbGF5LXRhc2stYnJpZGdlLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsicmVwbGF5LXRhc2stYnJpZGdlLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBLGlIQUFpSDtBQUNqSCwyR0FBMkc7QUFDM0csK0dBQStHO0FBQy9HLEVBQUU7QUFDRixnSEFBZ0g7QUFDaEgsbUhBQW1IO0FBQ25ILGtIQUFrSDtBQUNsSCw4R0FBOEc7QUFDOUcsNEdBQTRHO0FBQzVHLGdIQUFnSDtBQUNoSCxrREFBa0Q7QUFDbEQsRUFBRTtBQUNGLDRHQUE0RztBQUM1RyxvSEFBb0g7QUFDcEgsa0hBQWtIO0FBQ2xILGtIQUFrSDtBQUNsSCw4R0FBOEc7QUFDOUcsbUdBQW1HO0FBRW5HLE9BQU8sRUFBRSx3QkFBd0IsRUFBRSxrQkFBa0IsRUFBRSxNQUFNLDZCQUE2QixDQUFDO0FBMkMzRixTQUFTLGNBQWMsQ0FBQyxRQUF3QjtJQUM5QyxJQUFJLENBQUMsUUFBUSxJQUFJLE9BQU8sUUFBUSxLQUFLLFFBQVEsSUFBSSxLQUFLLENBQUMsT0FBTyxDQUFDLFFBQVEsQ0FBQyxFQUFFLENBQUM7UUFDekUsTUFBTSxJQUFJLEtBQUssQ0FBQyx5QkFBeUIsQ0FBQyxDQUFDO0lBQzdDLENBQUM7SUFDRCxPQUFPLFFBQVEsQ0FBQztBQUNsQixDQUFDO0FBRUQsU0FBUyxlQUFlLENBQUMsUUFBd0I7SUFDL0MsT0FBTyxLQUFLLENBQUMsT0FBTyxDQUFDLFFBQVEsQ0FBQyxPQUFPLENBQUMsQ0FBQyxDQUFDLENBQUMsUUFBUSxDQUFDLE9BQU8sQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDO0FBQ2pFLENBQUM7QUFFRCxpSEFBaUg7QUFDakgsa0hBQWtIO0FBQ2xILDBHQUEwRztBQUMxRyx5RUFBeUU7QUFDekUsTUFBTSxVQUFVLHlCQUF5QixDQUFDLFFBQXdCO0lBQ2hFLGNBQWMsQ0FBQyxRQUFRLENBQUMsQ0FBQztJQUN6QixNQUFNLEtBQUssR0FBYSxFQUFFLENBQUM7SUFD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