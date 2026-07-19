export type FetchWithRetryOptions = {
    maxAttempts?: number;
    sleepFn?: (ms: number) => Promise<unknown>;
    backoffMs?: (attempt: number) => number;
    timeoutMs?: number;
};
/** Exponential backoff from a base delay, capped: attempt 1 → base, 2 → 2×base, 3 → 4×base, … ≤ MAX_BACKOFF_MS. */
export declare function defaultRetryBackoffMs(attempt: number): number;
/**
 * Perform `fetchFn(url, init)` with bounded retry on a transient 5xx OR rate-limit (429 / secondary-403) response.
 * A retryable status is retried (sleeping `Retry-After` or `backoffMs(attempt)`, whichever is longer, between
 * attempts) up to `maxAttempts`; any other 2xx/3xx/4xx response is returned immediately, and after the last attempt
 * a lingering retryable status is returned as-is (the caller's own error handling still runs). A THROWN
 * error is NOT retried — it propagates to the caller (the pollers' #4281 failure-mode contract). When `timeoutMs`
 * is given, each attempt gets its own fresh abort timeout (a stalled connection is exactly the kind of network-
 * level failure #4281 already bubbles unretried, so a timed-out attempt propagates the same way).
 */
export declare function fetchWithRetry<Response extends {
    status: number;
}>(fetchFn: (url: unknown, init?: unknown) => Promise<Response>, url: unknown, init?: unknown, options?: FetchWithRetryOptions): Promise<Response>;
