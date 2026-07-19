export type WorktreeAllocation = {
    slotIndex: number;
    worktreePath: string;
    attemptId: string | null;
    repoFullName: string | null;
    status: "free" | "active";
    ownerPid: number | null;
    ownerHost: string | null;
    allocatedAt: string | null;
};
export type WorktreeAllocator = {
    dbPath: string;
    worktreeBaseDir: string;
    maxConcurrency: number;
    maxLeaseMs: number;
    processPid: number;
    hostId: string;
    acquire(attemptId: string, repoFullName: string): WorktreeAllocation;
    release(attemptId: string): WorktreeAllocation | null;
    listSlots(): WorktreeAllocation[];
    close(): void;
};
export declare const DEFAULT_MAX_LEASE_MS: number;
export declare function resolveWorktreeAllocatorDbPath(env?: Record<string, string | undefined>): string;
export declare function resolveWorktreeBaseDir(env?: Record<string, string | undefined>): string;
export declare function isProcessAlive(pid: number): boolean;
/**
 * Opens the local worktree allocator store. On startup reclaims orphaned active slots — any slot past its
 * `maxLeaseMs` age (the container-agnostic guarantee for fleet mode's shared store), plus, as a same-host fast
 * path, any slot whose owner pid is confirmed dead in THIS host's PID namespace.
 */
export declare function openWorktreeAllocator(options?: {
    dbPath?: string;
    worktreeBaseDir?: string;
    maxConcurrency?: number;
    maxLeaseMs?: number;
    processPid?: number;
    hostId?: string;
    nowMs?: number;
}): WorktreeAllocator;
export declare function acquireWorktree(attemptId: string, repoFullName: string): WorktreeAllocation;
export declare function releaseWorktree(attemptId: string): WorktreeAllocation | null;
export declare function closeDefaultWorktreeAllocator(): void;
