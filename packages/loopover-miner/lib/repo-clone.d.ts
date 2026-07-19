export type EnsureRepoClonedResult = {
    ok: boolean;
    repoPath: string;
    error?: string;
};
export type RunGitFn = (args: string[], cwd: string, timeoutMs: number) => Promise<{
    ok: boolean;
    stdout: string;
    stderr: string;
}>;
export type RepoCloneLockOptions = {
    lockTimeoutMs?: number;
    lockStaleMs?: number;
    lockPollMs?: number;
    nowMs?: () => number;
    lockSleep?: (ms: number) => Promise<unknown>;
    isProcessAlive?: (pid: number) => boolean;
    openLock?: (lockPath: string) => number;
    writeLock?: (fd: number, data: string) => void;
};
type EnsureRepoClonedOptions = {
    baseBranch?: string;
    cloneBaseDir?: string;
    env?: Record<string, string | undefined>;
    timeoutMs?: number;
    remoteUrl?: string;
    runGit?: RunGitFn;
} & RepoCloneLockOptions;
export declare function resolveRepoCloneBaseDir(env?: Record<string, string | undefined>): string;
export declare const REPO_SEGMENT_PATTERN: RegExp;
export declare function isPathTraversalSegment(segment: string): boolean;
export declare function isValidRepoSegment(segment: unknown): boolean;
export declare function resolveRepoCloneDir(repoFullName: string, env?: Record<string, string | undefined>): string;
/**
 * Decide whether an existing clone lockfile is stale (reclaimable): true when the file is missing or its JSON is
 * unreadable/partial (a crash mid-write), when its owner pid is confirmed dead within the SAME host's namespace,
 * or -- ONLY for an owner this host cannot probe (a different host/container, or a malformed record with no
 * usable pid) -- when it is older than `staleMs`. A same-host owner whose pid IS probeable is judged purely by
 * liveness: a live one is never stale no matter how long its clone legitimately runs (age reclaim there would
 * yank the lock out from under an in-progress clone -- a double-holder bug), and a dead one is stale at once.
 */
export declare function isRepoCloneLockStale(lockPath: string, nowMs: number, staleMs: number, isAlive?: (pid: number) => boolean): boolean;
/**
 * Take the cross-process clone lock for `repoPath`, returning an idempotent `release()`. Atomically create-and-holds
 * `${repoPath}.clone.lock` (open .., 'wx'); on contention it reclaims a stale lock (see {@link isRepoCloneLockStale})
 * or waits `lockPollMs` between retries until `lockTimeoutMs` elapses, then throws `repo_clone_lock_timeout` (fail
 * closed). Registered for crash-safe cleanup so a SIGINT/SIGTERM releases it. `nowMs`/`lockSleep`/`isProcessAlive`/
 * `openLock`/`writeLock` are injectable for tests; every real caller relies on the defaults.
 */
export declare function acquireRepoCloneLock(repoPath: string, options?: RepoCloneLockOptions): Promise<() => void>;
/**
 * Serialize the git mutations of {@link ensureRepoClonedUnlocked} per resolved repo path so concurrent
 * same-repo attempts never race the shared base clone (#6762), while different repos still run in parallel.
 * Resolves the same `repoPath` the unlocked step computes and uses it as the mutex key; throws (before
 * locking) on a malformed `repoFullName`, matching the prior behaviour.
 */
export declare function ensureRepoCloned(repoFullName: string, options?: EnsureRepoClonedOptions): Promise<EnsureRepoClonedResult>;
export {};
