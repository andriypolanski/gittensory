import { Buffer } from "node:buffer";
import { resolveAiPolicyVerdict } from "@loopover/engine";
import { resolveForgeConfig } from "./forge-config.js";
import { DEFAULT_RATE_LIMIT_HIGH_WATER_MARK, DEFAULT_RATE_LIMIT_LOW_WATER_MARK, resolveThrottledConcurrency, } from "./discovery-throttle.js";
import { fetchWithRetry } from "./http-retry.js";
const defaultConcurrency = 5;
// How long a parked worker waits before re-checking the live rate-limit-derived concurrency limit (#4844).
const throttleParkMs = 25;
const defaultPerPage = 100;
// Follow the GitHub Link header past the first page so a repo/search with >100 open issues isn't silently
// truncated (#4831); cap the follow loop so a pathological Link chain can't run away.
const defaultMaxPages = 10;
const defaultRequestTimeoutMs = 10_000;
function normalizeLimit(value, fallback, min, max) {
    if (!Number.isFinite(value))
        return fallback;
    return Math.min(max, Math.max(min, Math.floor(value)));
}
function targetKey(target) {
    return `${target.owner.toLowerCase()}/${target.repo.toLowerCase()}`;
}
function normalizeTargets(targets) {
    const seen = new Set();
    const normalized = [];
    for (const target of Array.isArray(targets) ? targets : []) {
        const owner = typeof target?.owner === "string" ? target.owner.trim() : "";
        const repo = typeof target?.repo === "string" ? target.repo.trim() : "";
        if (!owner || !repo)
            continue;
        const key = targetKey({ owner, repo });
        if (seen.has(key))
            continue;
        seen.add(key);
        normalized.push({ owner, repo, repoFullName: `${owner}/${repo}` });
    }
    return normalized;
}
function targetFromFullName(fullName) {
    if (typeof fullName !== "string")
        return null;
    const [owner, repo, extra] = fullName.split("/");
    if (!owner || !repo || extra)
        return null;
    return { owner, repo, repoFullName: `${owner}/${repo}` };
}
function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
// Derive owner/repo from a search hit when `repository.full_name` is absent, using the tenant forge's own
// `repoPathPrefix` for the API `repository_url` and a forge-agnostic host for the web `html_url` (#4784). Hardcoding
// `/repos/` and `github.com` here dropped every custom-forge search result whose payload omitted `full_name`.
function targetFromSearchIssue(issue, forge) {
    const repositoryFullName = targetFromFullName(issue?.repository?.full_name);
    if (repositoryFullName)
        return repositoryFullName;
    const repoPathPrefix = escapeRegExp(forge.repoPathPrefix.replace(/\/+$/, ""));
    const repositoryUrl = typeof issue?.repository_url === "string"
        ? issue.repository_url.match(new RegExp(`${repoPathPrefix}/([^/?#]+)/([^/?#]+)(?:[?#].*)?$`))
        : null;
    if (repositoryUrl) {
        const owner = decodeURIComponent(repositoryUrl[1]);
        const repo = decodeURIComponent(repositoryUrl[2]);
        return { owner, repo, repoFullName: `${owner}/${repo}` };
    }
    const htmlUrl = typeof issue?.html_url === "string"
        ? issue.html_url.match(/^https:\/\/[^/]+\/([^/]+)\/([^/]+)\/issues\/\d+(?:[?#].*)?$/)
        : null;
    if (htmlUrl) {
        const owner = decodeURIComponent(htmlUrl[1]);
        const repo = decodeURIComponent(htmlUrl[2]);
        return { owner, repo, repoFullName: `${owner}/${repo}` };
    }
    return null;
}
function githubHeaders(githubToken, forge) {
    const headers = {
        accept: forge.acceptHeader,
        "user-agent": forge.userAgent,
        [forge.apiVersionHeader]: forge.apiVersion,
    };
    const token = typeof githubToken === "string" ? githubToken.trim() : "";
    if (token)
        headers.authorization = `Bearer ${token}`;
    return headers;
}
function apiUrl(apiBaseUrl, path, query = "") {
    return `${apiBaseUrl.replace(/\/+$/, "")}${path}${query}`;
}
function repoPath(forge, target, suffix) {
    return `${forge.repoPathPrefix}/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}${suffix}`;
}
function recordRateLimit(summary, response) {
    const remaining = Number(response.headers.get("x-ratelimit-remaining"));
    if (Number.isFinite(remaining)) {
        summary.rateLimitRemaining =
            summary.rateLimitRemaining === null
                ? remaining
                : Math.min(summary.rateLimitRemaining, remaining);
    }
    const resetSeconds = Number(response.headers.get("x-ratelimit-reset"));
    if (Number.isFinite(resetSeconds) && resetSeconds > 0) {
        const resetAt = new Date(resetSeconds * 1000).toISOString();
        summary.rateLimitResetAt =
            summary.rateLimitResetAt === null || resetAt > summary.rateLimitResetAt
                ? resetAt
                : summary.rateLimitResetAt;
    }
}
async function githubGetJson(url, githubToken, summary, options, extraHeaders = {}) {
    // Retry a transient 5xx from GitHub before dropping this target's results for the whole run (#4830) — the same
    // discipline as the CI/gate-verdict pollers. A thrown network error still propagates to each caller's try/catch.
    // `extraHeaders` carries per-call additions (e.g. a policy-doc If-None-Match, #4842) on top of the base auth set.
    // requestTimeoutMs bounds each individual attempt so a stalled connection can't hang discovery forever
    // (#miner-github-read-timeouts) -- fetchWithRetry gives each retry its own fresh AbortSignal.timeout().
    // Spread-omit sleepFn when absent rather than passing `sleepFn: undefined` -- FetchWithRetryOptions doesn't
    // widen its optional properties to `| undefined`, and exactOptionalPropertyTypes treats those as different.
    const retryOptions = { ...(options?.sleepFn ? { sleepFn: options.sleepFn } : {}), timeoutMs: options?.requestTimeoutMs };
    const response = await fetchWithRetry(fetch, url, { method: "GET", headers: { ...githubHeaders(githubToken, options.forge), ...extraHeaders } }, retryOptions);
    recordRateLimit(summary, response);
    const payload = await response.json().catch(() => null);
    return { response, payload };
}
function decodeContentPayload(payload) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload))
        return null;
    const content = payload;
    if (typeof content.content !== "string")
        return null;
    if (content.encoding === "base64") {
        return Buffer.from(content.content.replace(/\s/g, ""), "base64").toString("utf8");
    }
    return content.content;
}
function warning(target, stage, message) {
    return { repoFullName: target.repoFullName, stage, message };
}
// Read a URL's prior ETag so an unchanged doc can be revalidated with a conditional GET (#4842). A cache that is
// absent, or whose read throws (corrupt/locked file), is treated as a plain miss: the caller does a full fetch,
// per the "never risk a stale policy" rule — the cache only ever makes discovery cheaper, never less correct.
function readCachedPolicyDoc(cache, url) {
    if (!cache)
        return null;
    try {
        return cache.get(url);
    }
    catch {
        return null;
    }
}
function readEtagHeader(response) {
    const etag = response.headers.get("etag");
    return typeof etag === "string" && etag.trim() ? etag : null;
}
// Persist the fresh ETag + body so the NEXT discover run can revalidate instead of re-downloading. Only a real
// ETag paired with decoded content is stored, and a write that throws must never fail discovery (same stale-safe
// rule) — it degrades to "not cached", so the next run simply refetches in full.
function writeCachedPolicyDoc(cache, url, etag, content) {
    if (!cache || content === null || etag === null)
        return;
    try {
        cache.put(url, etag, content);
    }
    catch {
        // Leave this URL uncached; the next run refetches fully rather than serving anything stale.
    }
}
// A bare `owner/repo` is NOT a safe policy-verdict cache key: two different tenant forge hosts (#4784's
// per-tenant `apiBaseUrl`) can each have their own unrelated repo of the same name, and their policy docs are
// wholly independent. Scope the key by host, mirroring policy-doc-cache.js's own precedent of keying on the full
// request URL rather than a bare path.
function policyVerdictCacheKey(apiBaseUrl, repoFullName) {
    return `${apiBaseUrl}::${repoFullName}`;
}
// Read a repo scope's previously-resolved verdict for the SAME decisive doc + ETag (#4843). A cache that is
// absent, or whose read throws (corrupt/locked file), is treated as a plain miss — the caller resolves the
// verdict fresh, per the same "never risk a stale policy" rule as the doc cache above.
function readCachedPolicyVerdict(cache, repoScope) {
    if (!cache)
        return null;
    try {
        return cache.get(repoScope);
    }
    catch {
        return null;
    }
}
// Persist the freshly-resolved verdict against the ETag of the doc that decided it, so the next run can reuse it
// outright once that ETag is confirmed unchanged. Only ever called with a real ETag; a write that throws must
// never fail discovery — it degrades to "not cached", so the next run just resolves the verdict again.
function writeCachedPolicyVerdict(cache, repoScope, decisiveDoc, etag, verdict) {
    if (!cache || etag === null)
        return;
    try {
        cache.put(repoScope, decisiveDoc, etag, verdict);
    }
    catch {
        // Leave this repo scope uncached; the next run just resolves the verdict fresh again.
    }
}
async function fetchRepoDoc(target, path, githubToken, options, summary, warnings) {
    const url = apiUrl(options.apiBaseUrl, repoPath(options.forge, target, `/contents/${encodeURIComponent(path)}`));
    const cached = readCachedPolicyDoc(options.policyDocCache, url);
    const conditionalHeaders = cached ? { "if-none-match": cached.etag } : {};
    try {
        const { response, payload } = await githubGetJson(url, githubToken, summary, options, conditionalHeaders);
        // A 304 only ever follows the If-None-Match we send above, which we only send when `cached` exists — so the
        // cached body is the GitHub-confirmed current content, served with no extra rate-limit spend.
        if (response.status === 304)
            return { content: cached.content, etag: cached.etag };
        if (response.status === 404)
            return { content: null, etag: null };
        if (!response.ok) {
            warnings.push(warning(target, `policy:${path}`, `GitHub returned ${response.status}`));
            return { content: null, etag: null };
        }
        const content = decodeContentPayload(payload);
        const etag = readEtagHeader(response);
        writeCachedPolicyDoc(options.policyDocCache, url, etag, content);
        return { content, etag };
    }
    catch (error) {
        warnings.push(warning(target, `policy:${path}`, error instanceof Error ? error.message : "policy fetch failed"));
        return { content: null, etag: null };
    }
}
// Resolve a repo scope's AI-usage-policy verdict, reusing a cached one when the deciding doc's ETag hasn't moved
// since it was last resolved (#4843). Only ever consulted with an ETag that a same-run conditional-GET just
// confirmed is current, so a cache hit is exactly as correct as recomputing — it just skips the (cheap, but not
// free) parse.
function resolveOrCacheVerdict(cache, repoScope, decisiveDoc, etag, computeVerdict) {
    if (etag !== null) {
        const cached = readCachedPolicyVerdict(cache, repoScope);
        if (cached && cached.decisiveDoc === decisiveDoc && cached.etag === etag)
            return cached.verdict;
    }
    const verdict = computeVerdict();
    writeCachedPolicyVerdict(cache, repoScope, decisiveDoc, etag, verdict);
    return verdict;
}
async function resolveRepoAiPolicy(target, githubToken, options, summary, warnings) {
    const repoScope = policyVerdictCacheKey(options.apiBaseUrl, target.repoFullName);
    const { content: aiUsage, etag: aiUsageEtag } = await fetchRepoDoc(target, "AI-USAGE.md", githubToken, options, summary, warnings);
    // Short-circuit only on AI-USAGE.md that has real content. A present-but-blank AI-USAGE.md must still fall
    // through to CONTRIBUTING.md — otherwise a stub AI-USAGE.md silently fails open and swallows a ban declared in
    // CONTRIBUTING.md (the exact case resolveAiPolicyVerdict was fixed to handle in #2900, which can only fire if
    // both docs reach it).
    if (aiUsage !== null && aiUsage.trim().length > 0) {
        return resolveOrCacheVerdict(options.policyVerdictCache, repoScope, "AI-USAGE.md", aiUsageEtag, () => resolveAiPolicyVerdict({ aiUsage, contributing: null }));
    }
    const { content: contributing, etag: contributingEtag } = await fetchRepoDoc(target, "CONTRIBUTING.md", githubToken, options, summary, warnings);
    return resolveOrCacheVerdict(options.policyVerdictCache, repoScope, "CONTRIBUTING.md", contributingEtag, () => resolveAiPolicyVerdict({ aiUsage: null, contributing }));
}
function labelNames(labels) {
    if (!Array.isArray(labels))
        return [];
    return labels
        .map((label) => {
        if (typeof label === "string")
            return label;
        if (label && typeof label === "object" && typeof label.name === "string") {
            return label.name;
        }
        return "";
    })
        .filter((name) => name.length > 0);
}
// Assignee logins (#7040): GitHub's issue-list/search payloads already carry `assignees` in the same response
// that supplies labels/comments/etc. -- no extra request needed. contribution-profile-filter.js's
// assignee-exclusion rule uses this to drop candidates assigned to a login the target repo considers off-limits
// (its own owner, by default).
function assigneeLogins(assignees) {
    if (!Array.isArray(assignees))
        return [];
    return assignees
        .map((assignee) => assignee && typeof assignee === "object" && typeof assignee.login === "string"
        ? assignee.login
        : "")
        .filter((login) => login.length > 0);
}
function normalizeIssue(target, issue, policySource) {
    if (!issue || typeof issue !== "object" || issue.pull_request)
        return null;
    const candidate = issue;
    if (!Number.isInteger(candidate.number) || candidate.number <= 0)
        return null;
    if (typeof candidate.title !== "string" || candidate.title.trim().length === 0)
        return null;
    return {
        owner: target.owner,
        repo: target.repo,
        repoFullName: target.repoFullName,
        issueNumber: candidate.number,
        title: candidate.title,
        labels: labelNames(candidate.labels),
        assignees: assigneeLogins(candidate.assignees),
        commentsCount: Number.isFinite(candidate.comments) ? candidate.comments : 0,
        createdAt: typeof candidate.created_at === "string" ? candidate.created_at : null,
        updatedAt: typeof candidate.updated_at === "string" ? candidate.updated_at : null,
        htmlUrl: typeof candidate.html_url === "string" ? candidate.html_url : null,
        aiPolicyAllowed: true,
        aiPolicySource: policySource,
    };
}
function searchQueryWithIssueQualifiers(searchQuery, forge) {
    const trimmed = typeof searchQuery === "string" ? searchQuery.trim() : "";
    if (!trimmed)
        return "";
    return `${trimmed} ${forge.searchQualifiers}`;
}
// The URL of the next page from a GitHub Link header (`<url>; rel="next"`), constrained to the current
// token-bearing GitHub API endpoint so a forged Link header cannot redirect credentials off-origin.
function nextPageUrl(response, apiBaseUrl, expectedPath) {
    const linkHeader = response.headers.get("link") ?? "";
    const match = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
    if (match === null)
        return null;
    let nextUrl;
    let expectedUrl;
    try {
        expectedUrl = new URL(apiUrl(apiBaseUrl, expectedPath));
        nextUrl = new URL(match[1], expectedUrl);
    }
    catch {
        return null;
    }
    if (nextUrl.protocol !== "https:" ||
        nextUrl.origin !== expectedUrl.origin ||
        nextUrl.pathname !== expectedUrl.pathname) {
        return null;
    }
    return nextUrl.toString();
}
async function fetchTargetIssues(target, githubToken, options, summary, warnings) {
    const verdict = await resolveRepoAiPolicy(target, githubToken, options, summary, warnings);
    if (!verdict.allowed)
        return [];
    const issuesPath = repoPath(options.forge, target, "/issues");
    let url = apiUrl(options.apiBaseUrl, issuesPath, `?state=open&per_page=${options.perPage}`);
    const issues = [];
    try {
        for (let page = 0; url !== null && page < options.maxPages; page += 1) {
            const { response, payload } = await githubGetJson(url, githubToken, summary, options);
            if (!response.ok) {
                warnings.push(warning(target, "issues", `GitHub returned ${response.status}`));
                return issues;
            }
            if (!Array.isArray(payload)) {
                warnings.push(warning(target, "issues", "GitHub returned a non-array issues payload"));
                return issues;
            }
            for (const issue of payload) {
                const normalized = normalizeIssue(target, issue, verdict.source);
                if (normalized !== null)
                    issues.push(normalized);
            }
            url = nextPageUrl(response, options.apiBaseUrl, issuesPath);
        }
        return issues;
    }
    catch (error) {
        warnings.push(warning(target, "issues", error instanceof Error ? error.message : "issue fetch failed"));
        return issues;
    }
}
async function fetchSearchIssues(searchQuery, githubToken, options, summary, warnings) {
    const qualifiedQuery = searchQueryWithIssueQualifiers(searchQuery, options.forge);
    if (!qualifiedQuery)
        return [];
    const searchPath = options.forge.searchEndpoint;
    let url = apiUrl(options.apiBaseUrl, searchPath, `?q=${encodeURIComponent(qualifiedQuery)}&per_page=${options.perPage}`);
    const items = [];
    try {
        for (let page = 0; url !== null && page < options.maxPages; page += 1) {
            const { response, payload } = await githubGetJson(url, githubToken, summary, options);
            if (!response.ok) {
                warnings.push({
                    repoFullName: "*",
                    stage: "search",
                    message: `GitHub returned ${response.status}`,
                });
                return items;
            }
            const searchPayload = payload;
            if (!searchPayload || typeof searchPayload !== "object" || !Array.isArray(searchPayload.items)) {
                warnings.push({
                    repoFullName: "*",
                    stage: "search",
                    message: "GitHub returned a non-array search payload",
                });
                return items;
            }
            items.push(...searchPayload.items);
            url = nextPageUrl(response, options.apiBaseUrl, searchPath);
        }
        return items;
    }
    catch (error) {
        warnings.push({
            repoFullName: "*",
            stage: "search",
            message: error instanceof Error ? error.message : "issue search failed",
        });
        return items;
    }
}
function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
// Run `worker` over `items` with a dynamic in-flight cap (#4844). The pool spawns `maxConcurrency` loops, but a
// loop parks (re-checking every `throttleParkMs`) whenever the live `resolveLimit()` — derived from the recorded
// rate-limit budget — is already met by the number of in-flight workers, so effective concurrency tapers off as
// the budget drops instead of sprinting into a 403. `sleepFn` lets tests inject an instant wait for the park.
export async function mapWithConcurrency(items, maxConcurrency, worker, resolveLimit, sleepFn) {
    const results = new Array(items.length);
    const sleep = sleepFn ?? delay;
    let next = 0;
    let active = 0;
    const runOne = async () => {
        while (next < items.length) {
            // Park while the live limit is already saturated. The check and the `active`/`next` bumps below run without
            // an intervening await, so two loops can never claim the same slot.
            while (active >= resolveLimit()) {
                await sleep(throttleParkMs);
            }
            // The shared cursor can be drained by other loops while this one is parked, so re-check before claiming.
            if (next >= items.length)
                return;
            const index = next;
            next += 1;
            active += 1;
            try {
                results[index] = await worker(items[index], index);
            }
            finally {
                active -= 1;
            }
        }
    };
    const workers = Array.from({ length: Math.min(maxConcurrency, items.length) }, runOne);
    await Promise.all(workers);
    return results;
}
/** A live limit resolver for `mapWithConcurrency`, reading the summary's rate-limit budget as it is updated (#4844). */
function liveConcurrencyResolver(normalizedOptions, summary) {
    return () => resolveThrottledConcurrency(normalizedOptions.concurrency, summary.rateLimitRemaining, normalizedOptions.rateLimitLowWaterMark, normalizedOptions.rateLimitHighWaterMark);
}
function normalizeOptions(options = {}) {
    // A legacy top-level `apiBaseUrl` (the pre-#4784 GitHub-Enterprise override every existing caller uses) still wins
    // over `forge.apiBaseUrl`, so nothing that already passes `apiBaseUrl` changes behavior.
    const apiBaseUrlOverride = typeof options.apiBaseUrl === "string" && options.apiBaseUrl.trim()
        ? { apiBaseUrl: options.apiBaseUrl }
        : {};
    const forge = resolveForgeConfig({ ...(options.forge ?? {}), ...apiBaseUrlOverride });
    return {
        forge,
        apiBaseUrl: forge.apiBaseUrl,
        concurrency: normalizeLimit(options.concurrency, defaultConcurrency, 1, 10),
        // Below/above these recorded-rate-limit-remaining marks the fanout serializes / runs at full concurrency; in
        // between it scales down linearly (#4844).
        rateLimitLowWaterMark: normalizeLimit(options.rateLimitLowWaterMark, DEFAULT_RATE_LIMIT_LOW_WATER_MARK, 0, 1_000_000),
        rateLimitHighWaterMark: normalizeLimit(options.rateLimitHighWaterMark, DEFAULT_RATE_LIMIT_HIGH_WATER_MARK, 1, 1_000_000),
        perPage: normalizeLimit(options.perPage, defaultPerPage, 1, 100),
        maxPages: normalizeLimit(options.maxPages, defaultMaxPages, 1, 100),
        requestTimeoutMs: normalizeLimit(options.requestTimeoutMs, defaultRequestTimeoutMs, 1, 60_000),
        // Passed through to the per-fetch retry so tests can inject an instant sleep; undefined uses the real backoff.
        sleepFn: typeof options.sleepFn === "function" ? options.sleepFn : undefined,
        // Optional local ETag cache for policy-doc revalidation (#4842). Absent (null) => every policy doc is fetched
        // in full, exactly as before; discover-cli.js supplies the real on-disk store for a live run.
        policyDocCache: options.policyDocCache ?? null,
        // Optional local cache of resolved policy verdicts (#4843). Absent (null) => every verdict is resolved fresh,
        // exactly as before; discover-cli.js supplies the real on-disk store for a live run.
        policyVerdictCache: options.policyVerdictCache ?? null,
    };
}
export async function fetchCandidateIssuesWithSummary(targets, githubToken, options = {}) {
    const normalizedOptions = normalizeOptions(options);
    const normalizedTargets = normalizeTargets(targets);
    const summary = {
        rateLimitRemaining: null,
        rateLimitResetAt: null,
    };
    const warnings = [];
    const batches = await mapWithConcurrency(normalizedTargets, normalizedOptions.concurrency, (target) => fetchTargetIssues(target, githubToken, normalizedOptions, summary, warnings), liveConcurrencyResolver(normalizedOptions, summary), normalizedOptions.sleepFn);
    return {
        issues: batches.flat(),
        rateLimitRemaining: summary.rateLimitRemaining,
        rateLimitResetAt: summary.rateLimitResetAt,
        warnings,
    };
}
/**
 * Metadata-only GitHub discovery (#2307): never clones source, never fetches blobs beyond small policy docs,
 * never uploads source, and never performs writes. Call the WithSummary variant when rate-limit telemetry is
 * needed.
 */
export async function fetchCandidateIssues(targets, githubToken, options = {}) {
    const result = await fetchCandidateIssuesWithSummary(targets, githubToken, options);
    return result.issues;
}
export async function searchCandidateIssuesWithSummary(searchQuery, githubToken, options = {}) {
    const normalizedOptions = normalizeOptions(options);
    const summary = {
        rateLimitRemaining: null,
        rateLimitResetAt: null,
    };
    const warnings = [];
    const searchItems = await fetchSearchIssues(searchQuery, githubToken, normalizedOptions, summary, warnings);
    const targetsByKey = new Map();
    for (const item of searchItems) {
        if (!item || typeof item !== "object" || item.pull_request)
            continue;
        const target = targetFromSearchIssue(item, normalizedOptions.forge);
        if (target && !targetsByKey.has(targetKey(target)))
            targetsByKey.set(targetKey(target), target);
    }
    const policyEntries = await mapWithConcurrency([...targetsByKey.values()], normalizedOptions.concurrency, async (target) => {
        const verdict = await resolveRepoAiPolicy(target, githubToken, normalizedOptions, summary, warnings);
        return [targetKey(target), verdict];
    }, liveConcurrencyResolver(normalizedOptions, summary), normalizedOptions.sleepFn);
    const policiesByKey = new Map(policyEntries);
    const issues = [];
    for (const item of searchItems) {
        const target = targetFromSearchIssue(item, normalizedOptions.forge);
        if (!target)
            continue;
        const policy = policiesByKey.get(targetKey(target));
        if (!policy?.allowed)
            continue;
        const normalizedIssue = normalizeIssue(target, item, policy.source);
        if (normalizedIssue)
            issues.push(normalizedIssue);
    }
    return {
        issues,
        rateLimitRemaining: summary.rateLimitRemaining,
        rateLimitResetAt: summary.rateLimitResetAt,
        warnings,
    };
}
export async function searchCandidateIssues(searchQuery, githubToken, options = {}) {
    const result = await searchCandidateIssuesWithSummary(searchQuery, githubToken, options);
    return result.issues;
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoib3Bwb3J0dW5pdHktZmFub3V0LmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsib3Bwb3J0dW5pdHktZmFub3V0LnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBLE9BQU8sRUFBRSxNQUFNLEVBQUUsTUFBTSxhQUFhLENBQUM7QUFFckMsT0FBTyxFQUFFLHNCQUFzQixFQUFFLE1BQU0sa0JBQWtCLENBQUM7QUFFMUQsT0FBTyxFQUFFLGtCQUFrQixFQUFFLE1BQU0sbUJBQW1CLENBQUM7QUFHdkQsT0FBTyxFQUNMLGtDQUFrQyxFQUNsQyxpQ0FBaUMsRUFDakMsMkJBQTJCLEdBQzVCLE1BQU0seUJBQXlCLENBQUM7QUFDakMsT0FBTyxFQUFFLGNBQWMsRUFBRSxNQUFNLGlCQUFpQixDQUFDO0FBa0ZqRCxNQUFNLGtCQUFrQixHQUFHLENBQUMsQ0FBQztBQUM3QiwyR0FBMkc7QUFDM0csTUFBTSxjQUFjLEdBQUcsRUFBRSxDQUFDO0FBQzFCLE1BQU0sY0FBYyxHQUFHLEdBQUcsQ0FBQztBQUMzQiwwR0FBMEc7QUFDMUcsc0ZBQXNGO0FBQ3RGLE1BQU0sZUFBZSxHQUFHLEVBQUUsQ0FBQztBQUMzQixNQUFNLHVCQUF1QixHQUFHLE1BQU0sQ0FBQztBQXVCdkMsU0FBUyxjQUFjLENBQUMsS0FBYyxFQUFFLFFBQWdCLEVBQUUsR0FBVyxFQUFFLEdBQVc7SUFDaEYsSUFBSSxDQUFDLE1BQU0sQ0FBQyxRQUFRLENBQUMsS0FBSyxDQUFDO1FBQUUsT0FBTyxRQUFRLENBQUM7SUFDN0MsT0FBTyxJQUFJLENBQUMsR0FBRyxDQUFDLEdBQUcsRUFBRSxJQUFJLENBQUMsR0FBRyxDQUFDLEdBQUcsRUFBRSxJQUFJLENBQUMsS0FBSyxDQUFDLEtBQWUsQ0FBQyxDQUFDLENBQUMsQ0FBQztBQUNuRSxDQUFDO0FBRUQsU0FBUyxTQUFTLENBQUMsTUFBdUM7SUFDeEQsT0FBTyxHQUFHLE1BQU0sQ0FBQyxLQUFLLENBQUMsV0FBVyxFQUFFLElBQUksTUFBTSxDQUFD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