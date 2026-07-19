// Bounded retry-with-backoff around a single HTTP call (#4829). The miner's pollers (ci-poller and others)
// previously let a single brief 5xx from GitHub kill the whole poll loop, because their own attempt loop
// only re-polls while a conclusion is genuinely "pending", never after a server error. This wraps ONE fetch so a
// transient SERVER error (a 5xx RESPONSE) or a transient GitHub RATE-LIMIT response (429 / secondary-403, #6761)
// is retried a bounded number of times, DISTINCT from that pending-polling, sleeping an exponential backoff (or
// the response's `Retry-After`, whichever is longer) between attempts and giving up after `maxAttempts`. Any other
// 2xx/3xx/4xx response — including a plain permission 403 — is returned immediately, and a THROWN error (a network-
// level failure) propagates unchanged rather than being retried — the pollers' existing failure-mode contract
// (#4281) deliberately bubbles those to the caller.
// Pure control flow over injected `fetchFn`/`sleepFn`/`backoffMs` — no real network or timers in tests.

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BASE_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 10_000;

export type FetchWithRetryOptions = {
  maxAttempts?: number;
  sleepFn?: (ms: number) => Promise<unknown>;
  backoffMs?: (attempt: number) => number;
  timeoutMs?: number;
};

type RetryableResponse = {
  status: number;
  headers?: { get?: (name: string) => string | null } | null;
};

/** Clamp `maxAttempts` to a positive integer, flooring BEFORE the positivity test so a fractional value below 1
 *  falls back to the default rather than becoming a 0 that would skip every attempt. */
function normalizeMaxAttempts(raw: unknown): number {
  const numeric = Math.floor(Number(raw));
  return Number.isFinite(numeric) && numeric >= 1 ? numeric : DEFAULT_MAX_ATTEMPTS;
}

/** Exponential backoff from a base delay, capped: attempt 1 → base, 2 → 2×base, 3 → 4×base, … ≤ MAX_BACKOFF_MS. */
export function defaultRetryBackoffMs(attempt: number): number {
  return Math.min(MAX_BACKOFF_MS, DEFAULT_BASE_BACKOFF_MS * 2 ** (Math.max(1, attempt) - 1));
}

const defaultSleep = (delayMs: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, delayMs));

/** Read a response header defensively — works with a real `Headers` object or a test stub exposing `.get()`. */
function readHeader(response: RetryableResponse, name: string): string | null {
  const headers = response && response.headers;
  return headers && typeof headers.get === "function" ? headers.get(name) : null;
}

/**
 * A transient GitHub rate-limit response the poll should ride out rather than abort on (#6761): a 429 (primary
 * rate limit / abuse), or a SECONDARY-rate-limit 403 — identified by a `Retry-After` header or `x-ratelimit-
 * remaining: 0`. A plain permission-denied 403 carries neither signal and is deliberately NOT treated as a rate
 * limit: it can never succeed, so retrying it would only burn the bounded attempt budget.
 */
function isRateLimitStatus(response: RetryableResponse): boolean {
  if (response.status === 429) return true;
  if (response.status !== 403) return false;
  if (readHeader(response, "retry-after") != null) return true;
  const remaining = readHeader(response, "x-ratelimit-remaining");
  return remaining != null && Number(remaining) === 0;
}

/** Retry a transient SERVER error (5xx) OR a transient rate-limit response (429 / secondary-403). (#6761) */
function isRetryableStatus(response: RetryableResponse): boolean {
  return response.status >= 500 || isRateLimitStatus(response);
}

/**
 * Delay before the next attempt. Honor a `Retry-After` header (delta-seconds) when GitHub sends one — but never
 * below the computed exponential backoff (so a tiny/zero value can't hammer) and never above MAX_BACKOFF_MS;
 * otherwise fall back to the exponential backoff alone. (#6761)
 */
function retryDelayMs(
  response: RetryableResponse,
  attempt: number,
  backoffMs: (attempt: number) => number,
): number {
  const base = backoffMs(attempt);
  const retryAfterSeconds = Number(readHeader(response, "retry-after"));
  if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0) {
    return Math.min(MAX_BACKOFF_MS, Math.max(base, retryAfterSeconds * 1000));
  }
  return base;
}

/**
 * Perform `fetchFn(url, init)` with bounded retry on a transient 5xx OR rate-limit (429 / secondary-403) response.
 * A retryable status is retried (sleeping `Retry-After` or `backoffMs(attempt)`, whichever is longer, between
 * attempts) up to `maxAttempts`; any other 2xx/3xx/4xx response is returned immediately, and after the last attempt
 * a lingering retryable status is returned as-is (the caller's own error handling still runs). A THROWN
 * error is NOT retried — it propagates to the caller (the pollers' #4281 failure-mode contract). When `timeoutMs`
 * is given, each attempt gets its own fresh abort timeout (a stalled connection is exactly the kind of network-
 * level failure #4281 already bubbles unretried, so a timed-out attempt propagates the same way).
 */
export async function fetchWithRetry<Response extends { status: number }>(
  fetchFn: (url: unknown, init?: unknown) => Promise<Response>,
  url: unknown,
  init?: unknown,
  options: FetchWithRetryOptions = {},
): Promise<Response> {
  const maxAttempts = normalizeMaxAttempts(options.maxAttempts);
  const sleepFn = typeof options.sleepFn === "function" ? options.sleepFn : defaultSleep;
  const backoffMs = typeof options.backoffMs === "function" ? options.backoffMs : defaultRetryBackoffMs;
  for (let attempt = 1; ; attempt += 1) {
    // A thrown error is intentionally NOT caught here — it propagates to the caller unchanged.
    const response = await fetchOnce(fetchFn, url, init, options.timeoutMs);
    // Retry transient SERVER errors (5xx) AND transient GitHub rate-limit responses (429 / secondary-403, #6761).
    // Everything else (2xx/3xx/other 4xx incl. a plain permission 403) is returned immediately; on the final
    // attempt a lingering retryable status is returned as-is so the caller's own error handling still runs.
    if (!isRetryableStatus(response) || attempt >= maxAttempts) return response;
    await sleepFn(retryDelayMs(response, attempt, backoffMs));
  }
}

// A fresh AbortSignal.timeout() per attempt, never one shared across retries -- reusing a single signal would
// leave every attempt after the first pre-aborted the instant it fired once. AbortSignal.timeout()'s own internal
// timer is unref'd (verified: it never keeps a short-lived CLI process alive past its own work), so unlike a raw
// setTimeout it needs no manual clearTimeout -- mirrors src/github/client.ts's timeoutFetch in the main repo. A
// no-op passthrough (no `init` copy) when `timeoutMs` is absent/non-positive, so every existing caller that
// doesn't opt in sees zero behavior change.
function fetchOnce<Response>(
  fetchFn: (url: unknown, init?: unknown) => Promise<Response>,
  url: unknown,
  init: unknown,
  timeoutMs: number | undefined,
): Promise<Response> {
  if (!Number.isFinite(timeoutMs) || (timeoutMs as number) <= 0) return fetchFn(url, init);
  return fetchFn(url, { ...(init as object), signal: AbortSignal.timeout(timeoutMs as number) });
}
