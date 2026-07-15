import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/api/routes";
import { completeGitHubWebOAuth, getLiveSessionGitHubToken, pollGitHubDeviceFlow, startGitHubWebOAuth } from "../../src/auth/github-oauth";
import { authenticatePrivateToken, createSessionForGitHubUser, revokeSession } from "../../src/auth/security";
import { deleteSessionGitHubToken, getDecryptedSessionGitHubToken, getDecryptedSessionGitHubTokenBundle, storeSessionGitHubToken } from "../../src/db/repositories";
import { createTestEnv } from "../helpers/d1";

const SECRET = "example-unit-test-encryption-secret-32-bytes-long";

describe("session GitHub token storage (#6114)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("stores an encrypted token at session creation and decrypts it at call time", async () => {
    const env = createTestEnv({ TOKEN_ENCRYPTION_SECRET: SECRET });
    const { session } = await createSessionForGitHubUser(env, { login: "jsonbored", id: 42 }, { githubToken: "gh-token-abc123" });
    await expect(getDecryptedSessionGitHubToken(env, session.id)).resolves.toBe("gh-token-abc123");

    // The persisted row stores ciphertext, never the plaintext token.
    const row = await env.DB.prepare("select ciphertext, iv from auth_session_github_tokens where session_id = ?").bind(session.id).first<{ ciphertext: string; iv: string }>();
    expect(row?.ciphertext).not.toContain("gh-token-abc123");
  });

  it("does not persist anything when no githubToken is supplied (ordinary sessions unaffected)", async () => {
    const env = createTestEnv({ TOKEN_ENCRYPTION_SECRET: SECRET });
    const { session } = await createSessionForGitHubUser(env, { login: "jsonbored", id: 42 });
    await expect(getDecryptedSessionGitHubToken(env, session.id)).resolves.toBeNull();
    const row = await env.DB.prepare("select session_id from auth_session_github_tokens where session_id = ?").bind(session.id).first();
    expect(row ?? null).toBeNull();
  });

  it("REGRESSION: session creation still succeeds when TOKEN_ENCRYPTION_SECRET is unset, warning instead of throwing (#6114 -- unlike BYOK/Linear keys, there is no re-mint fallback for a user's own OAuth token)", async () => {
    const env = createTestEnv({});
    const warnings = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { token, session } = await createSessionForGitHubUser(env, { login: "jsonbored", id: 42 }, { githubToken: "gh-token-xyz" });
    expect(token).toBeTruthy(); // the loopover session itself was still created
    await expect(getDecryptedSessionGitHubToken(env, session.id)).resolves.toBeNull();
    expect(warnings.mock.calls.some(([line]) => String(line).includes("session_github_token_persist_skipped") && String(line).includes(session.id))).toBe(true);
    warnings.mockRestore();
  });

  it("returns null (not throw) when decrypting with a rotated/wrong encryption secret", async () => {
    const env = createTestEnv({ TOKEN_ENCRYPTION_SECRET: SECRET });
    const { session } = await createSessionForGitHubUser(env, { login: "jsonbored", id: 42 }, { githubToken: "gh-token-abc123" });
    const wrongSecretEnv = { ...env, TOKEN_ENCRYPTION_SECRET: "totally-different-example-secret-32-bytes-min" } as unknown as Env;
    await expect(getDecryptedSessionGitHubToken(wrongSecretEnv, session.id)).resolves.toBeNull();
    const noSecretEnv = { ...env, TOKEN_ENCRYPTION_SECRET: undefined } as unknown as Env;
    await expect(getDecryptedSessionGitHubToken(noSecretEnv, session.id)).resolves.toBeNull();
  });

  it("returns null for a session id that was never stored at all", async () => {
    const env = createTestEnv({ TOKEN_ENCRYPTION_SECRET: SECRET });
    await expect(getDecryptedSessionGitHubToken(env, "nonexistent-session-id")).resolves.toBeNull();
  });

  it("replaces the stored token on re-authentication, not append/duplicate", async () => {
    const env = createTestEnv({ TOKEN_ENCRYPTION_SECRET: SECRET });
    const { session } = await createSessionForGitHubUser(env, { login: "jsonbored", id: 42 }, { githubToken: "first-token" });
    await storeSessionGitHubToken(env, session.id, "second-token");
    await expect(getDecryptedSessionGitHubToken(env, session.id)).resolves.toBe("second-token");
    const count = await env.DB.prepare("select count(*) as n from auth_session_github_tokens where session_id = ?").bind(session.id).first<{ n: number }>();
    expect(count?.n).toBe(1);
  });

  it("revokeSession deletes the stored GitHub token, not just the loopover session", async () => {
    const env = createTestEnv({ TOKEN_ENCRYPTION_SECRET: SECRET });
    const { token, session } = await createSessionForGitHubUser(env, { login: "jsonbored", id: 42 }, { githubToken: "gh-token-abc123" });
    const identity = await authenticatePrivateToken(env, token);
    await revokeSession(env, identity);
    await expect(getDecryptedSessionGitHubToken(env, session.id)).resolves.toBeNull();
    const row = await env.DB.prepare("select session_id from auth_session_github_tokens where session_id = ?").bind(session.id).first();
    expect(row ?? null).toBeNull();
  });

  it("deleteSessionGitHubToken is a no-op (not an error) when nothing was ever stored", async () => {
    const env = createTestEnv({ TOKEN_ENCRYPTION_SECRET: SECRET });
    await expect(deleteSessionGitHubToken(env, "nonexistent-session-id")).resolves.toBeUndefined();
  });

  it("never appears in plaintext in the session-creation audit event", async () => {
    const env = createTestEnv({ TOKEN_ENCRYPTION_SECRET: SECRET });
    await createSessionForGitHubUser(env, { login: "jsonbored", id: 42 }, { githubToken: "super-secret-gh-token-value" });
    const events = await env.DB.prepare("select metadata_json, detail from audit_events where event_type = ?").bind("auth.session_created").all<{ metadata_json: string; detail: string | null }>();
    expect(JSON.stringify(events.results)).not.toContain("super-secret-gh-token-value");
  });

  it("the device-flow login persists the token end-to-end (not just the isolated repository function)", async () => {
    const env = createTestEnv({ GITHUB_OAUTH_CLIENT_ID: "client-id", TOKEN_ENCRYPTION_SECRET: SECRET });
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("access_token")) return Response.json({ access_token: "device-flow-gh-token", scope: "read:user" });
      if (url === "https://api.github.com/user") return Response.json({ login: "jsonbored", id: 42 });
      return Response.json({});
    });
    const result = await pollGitHubDeviceFlow(env, "device-code");
    if (!("token" in result)) throw new Error("expected an authenticated session result");
    const identity = await authenticatePrivateToken(env, result.token);
    if (identity?.kind !== "session") throw new Error("expected a session identity");
    await expect(getDecryptedSessionGitHubToken(env, identity.session.id)).resolves.toBe("device-flow-gh-token");
  });

  it("the web-OAuth login persists the token end-to-end", async () => {
    const env = createTestEnv({ GITHUB_OAUTH_CLIENT_ID: "client-id", GITHUB_OAUTH_CLIENT_SECRET: "client-secret", TOKEN_ENCRYPTION_SECRET: SECRET });
    const started = await startGitHubWebOAuth(env, "https://api.example/v1/auth/github/start", undefined);
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("access_token")) return Response.json({ access_token: "web-oauth-gh-token", scope: "read:user" });
      if (url === "https://api.github.com/user") return Response.json({ login: "jsonbored", id: 42 });
      return Response.json({});
    });
    const session = await completeGitHubWebOAuth(env, "https://api.example/v1/auth/github/callback", {
      code: "code",
      state: started.state,
      cookieState: started.state,
    });
    const identity = await authenticatePrivateToken(env, session.token);
    if (identity?.kind !== "session") throw new Error("expected a session identity");
    await expect(getDecryptedSessionGitHubToken(env, identity.session.id)).resolves.toBe("web-oauth-gh-token");
  });
});

describe("session GitHub token refresh (#6115)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("captures expires_in/refresh_token/refresh_token_expires_in end-to-end when GitHub's response includes them", async () => {
    const env = createTestEnv({ GITHUB_OAUTH_CLIENT_ID: "client-id", TOKEN_ENCRYPTION_SECRET: SECRET });
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-15T00:00:00.000Z"));
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("access_token")) {
        return Response.json({ access_token: "device-flow-gh-token", scope: "read:user", expires_in: 28800, refresh_token: "device-flow-refresh-token", refresh_token_expires_in: 15897600 });
      }
      if (url === "https://api.github.com/user") return Response.json({ login: "jsonbored", id: 42 });
      return Response.json({});
    });
    const result = await pollGitHubDeviceFlow(env, "device-code");
    if (!("token" in result)) throw new Error("expected an authenticated session result");
    const identity = await authenticatePrivateToken(env, result.token);
    if (identity?.kind !== "session") throw new Error("expected a session identity");
    const bundle = await getDecryptedSessionGitHubTokenBundle(env, identity.session.id);
    expect(bundle?.accessToken).toBe("device-flow-gh-token");
    expect(bundle?.expiresAt).toBe("2026-07-15T08:00:00.000Z"); // now + 28800s (8h)
    expect(bundle?.refreshToken).toBe("device-flow-refresh-token");
    expect(bundle?.refreshExpiresAt).toBe("2027-01-15T00:00:00.000Z"); // now + 15897600s (~6mo)
  });

  it("returns the access token as-is when nowhere near expiry (no refresh call made)", async () => {
    const env = createTestEnv({ GITHUB_OAUTH_CLIENT_ID: "client-id", GITHUB_OAUTH_CLIENT_SECRET: "client-secret", TOKEN_ENCRYPTION_SECRET: SECRET });
    const { session } = await createSessionForGitHubUser(env, { login: "jsonbored", id: 42 }, {
      githubToken: "fresh-token",
      githubTokenExpiresAt: new Date(Date.now() + 8 * 60 * 60_000).toISOString(),
      githubRefreshToken: "unused-refresh-token",
      githubRefreshTokenExpiresAt: new Date(Date.now() + 180 * 24 * 60 * 60_000).toISOString(),
    });
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await expect(getLiveSessionGitHubToken(env, session.id)).resolves.toBe("fresh-token");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refreshes when within the margin of expiry, persisting the new access + refresh tokens", async () => {
    const env = createTestEnv({ GITHUB_OAUTH_CLIENT_ID: "client-id", GITHUB_OAUTH_CLIENT_SECRET: "client-secret", TOKEN_ENCRYPTION_SECRET: SECRET });
    const { session } = await createSessionForGitHubUser(env, { login: "jsonbored", id: 42 }, {
      githubToken: "near-expiry-token",
      githubTokenExpiresAt: new Date(Date.now() + 60_000).toISOString(), // 1 minute left, well inside the 15min margin
      githubRefreshToken: "old-refresh-token",
      githubRefreshTokenExpiresAt: new Date(Date.now() + 180 * 24 * 60 * 60_000).toISOString(),
    });
    let capturedBody: unknown;
    vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedBody = JSON.parse(String(init?.body ?? "{}"));
      return Response.json({ access_token: "refreshed-token", expires_in: 28800, refresh_token: "new-refresh-token", refresh_token_expires_in: 15897600 });
    });

    await expect(getLiveSessionGitHubToken(env, session.id)).resolves.toBe("refreshed-token");
    expect(capturedBody).toMatchObject({ grant_type: "refresh_token", refresh_token: "old-refresh-token", client_id: "client-id", client_secret: "client-secret" });

    const bundle = await getDecryptedSessionGitHubTokenBundle(env, session.id);
    expect(bundle?.accessToken).toBe("refreshed-token");
    expect(bundle?.refreshToken).toBe("new-refresh-token"); // rotated, not the old one left in place
  });

  it("falls back to the (possibly-stale) access token when there is nothing to refresh WITH", async () => {
    const env = createTestEnv({ GITHUB_OAUTH_CLIENT_ID: "client-id", GITHUB_OAUTH_CLIENT_SECRET: "client-secret", TOKEN_ENCRYPTION_SECRET: SECRET });
    const { session } = await createSessionForGitHubUser(env, { login: "jsonbored", id: 42 }, {
      githubToken: "near-expiry-no-refresh-token",
      githubTokenExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      // No githubRefreshToken supplied at all.
    });
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await expect(getLiveSessionGitHubToken(env, session.id)).resolves.toBe("near-expiry-no-refresh-token");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns null (no network call) when the refresh token itself has already expired", async () => {
    const env = createTestEnv({ GITHUB_OAUTH_CLIENT_ID: "client-id", GITHUB_OAUTH_CLIENT_SECRET: "client-secret", TOKEN_ENCRYPTION_SECRET: SECRET });
    const { session } = await createSessionForGitHubUser(env, { login: "jsonbored", id: 42 }, {
      githubToken: "dead-end-token",
      githubTokenExpiresAt: new Date(Date.now() - 60_000).toISOString(), // already expired
      githubRefreshToken: "dead-refresh-token",
      githubRefreshTokenExpiresAt: new Date(Date.now() - 1000).toISOString(), // the refresh token is ALSO dead
    });
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await expect(getLiveSessionGitHubToken(env, session.id)).resolves.toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled(); // no point attempting a refresh that's guaranteed to fail
  });

  it("treats an absent expiresAt as never-expiring, for backward compat with #6114-era rows", async () => {
    const env = createTestEnv({ TOKEN_ENCRYPTION_SECRET: SECRET });
    const { session } = await createSessionForGitHubUser(env, { login: "jsonbored", id: 42 }, { githubToken: "pre-6115-token" });
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await expect(getLiveSessionGitHubToken(env, session.id)).resolves.toBe("pre-6115-token");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns null when the token was never stored at all", async () => {
    const env = createTestEnv({ TOKEN_ENCRYPTION_SECRET: SECRET });
    await expect(getLiveSessionGitHubToken(env, "nonexistent-session")).resolves.toBeNull();
  });

  it("recovers from a failed refresh when a concurrent request already rotated the same refresh token", async () => {
    const env = createTestEnv({ GITHUB_OAUTH_CLIENT_ID: "client-id", GITHUB_OAUTH_CLIENT_SECRET: "client-secret", TOKEN_ENCRYPTION_SECRET: SECRET });
    const { session } = await createSessionForGitHubUser(env, { login: "jsonbored", id: 42 }, {
      githubToken: "near-expiry-token",
      githubTokenExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      githubRefreshToken: "already-rotated-refresh-token",
      githubRefreshTokenExpiresAt: new Date(Date.now() + 180 * 24 * 60 * 60_000).toISOString(),
    });
    // This attempt's own refresh call fails (GitHub rejects the now-rotated refresh token) -- but as a side
    // effect of that SAME mocked call, simulate a concurrent request's own successful refresh landing in the
    // DB in the window between this function's initial read (already completed, which is why fetch is being
    // called at all) and its post-failure retry read. Writing the "concurrent" update inside the fetch mock
    // (rather than before calling getLiveSessionGitHubToken) is what actually exercises the retry path --
    // writing it beforehand would just make the function's own INITIAL read see the fresh token directly.
    vi.stubGlobal("fetch", async () => {
      await storeSessionGitHubToken(env, session.id, "concurrently-refreshed-token", {
        expiresAt: new Date(Date.now() + 8 * 60 * 60_000).toISOString(),
        refreshToken: "concurrently-rotated-refresh-token",
        refreshExpiresAt: new Date(Date.now() + 180 * 24 * 60 * 60_000).toISOString(),
      });
      return Response.json({ error: "bad_refresh_token" });
    });

    await expect(getLiveSessionGitHubToken(env, session.id)).resolves.toBe("concurrently-refreshed-token");
  });

  it("returns null when refresh fails and no concurrent update landed either", async () => {
    const env = createTestEnv({ GITHUB_OAUTH_CLIENT_ID: "client-id", GITHUB_OAUTH_CLIENT_SECRET: "client-secret", TOKEN_ENCRYPTION_SECRET: SECRET });
    const { session } = await createSessionForGitHubUser(env, { login: "jsonbored", id: 42 }, {
      githubToken: "near-expiry-token",
      githubTokenExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      githubRefreshToken: "refresh-token",
      githubRefreshTokenExpiresAt: new Date(Date.now() + 180 * 24 * 60 * 60_000).toISOString(),
    });
    vi.stubGlobal("fetch", async () => Response.json({ error: "bad_refresh_token" }));
    await expect(getLiveSessionGitHubToken(env, session.id)).resolves.toBeNull();
  });

  it("returns null on the retry when the follow-up read finds nothing at all (e.g. the session was revoked mid-refresh)", async () => {
    const env = createTestEnv({ GITHUB_OAUTH_CLIENT_ID: "client-id", GITHUB_OAUTH_CLIENT_SECRET: "client-secret", TOKEN_ENCRYPTION_SECRET: SECRET });
    const { token, session } = await createSessionForGitHubUser(env, { login: "jsonbored", id: 42 }, {
      githubToken: "near-expiry-token",
      githubTokenExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      githubRefreshToken: "refresh-token",
      githubRefreshTokenExpiresAt: new Date(Date.now() + 180 * 24 * 60 * 60_000).toISOString(),
    });
    // The failed refresh attempt's own network call is the trigger point: simulate the session being revoked
    // (e.g. a concurrent logout) in the window between the failed refresh and this function's own retry read,
    // by deleting the stored token as a side effect of the mocked fetch itself.
    vi.stubGlobal("fetch", async () => {
      await deleteSessionGitHubToken(env, session.id);
      return Response.json({ error: "bad_refresh_token" });
    });
    await expect(getLiveSessionGitHubToken(env, session.id)).resolves.toBeNull();
    expect(token).toBeTruthy(); // sanity: the fixture session really was created
  });

  it("still attempts a refresh when refreshToken is present but refreshExpiresAt was never recorded", async () => {
    const env = createTestEnv({ GITHUB_OAUTH_CLIENT_ID: "client-id", GITHUB_OAUTH_CLIENT_SECRET: "client-secret", TOKEN_ENCRYPTION_SECRET: SECRET });
    const { session } = await createSessionForGitHubUser(env, { login: "jsonbored", id: 42 }, {
      githubToken: "near-expiry-token",
      githubTokenExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      githubRefreshToken: "refresh-token-no-known-expiry",
      // githubRefreshTokenExpiresAt deliberately omitted.
    });
    vi.stubGlobal("fetch", async () => Response.json({ access_token: "refreshed-token" }));
    await expect(getLiveSessionGitHubToken(env, session.id)).resolves.toBe("refreshed-token");
  });

  it("REGRESSION: refreshGitHubUserToken (via getLiveSessionGitHubToken) treats a malformed/non-JSON refresh response as a failure, not a crash", async () => {
    const env = createTestEnv({ GITHUB_OAUTH_CLIENT_ID: "client-id", GITHUB_OAUTH_CLIENT_SECRET: "client-secret", TOKEN_ENCRYPTION_SECRET: SECRET });
    const { session } = await createSessionForGitHubUser(env, { login: "jsonbored", id: 42 }, {
      githubToken: "near-expiry-token",
      githubTokenExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      githubRefreshToken: "refresh-token",
      githubRefreshTokenExpiresAt: new Date(Date.now() + 180 * 24 * 60 * 60_000).toISOString(),
    });
    vi.stubGlobal("fetch", async () => new Response("{", { status: 200 }));
    await expect(getLiveSessionGitHubToken(env, session.id)).resolves.toBeNull();
  });

  it("REGRESSION: refuses to refresh (and reports unavailable) when GITHUB_OAUTH_CLIENT_ID/SECRET are not configured", async () => {
    const env = createTestEnv({ TOKEN_ENCRYPTION_SECRET: SECRET });
    delete (env as Partial<Env>).GITHUB_OAUTH_CLIENT_ID;
    delete (env as Partial<Env>).GITHUB_OAUTH_CLIENT_SECRET;
    const { session } = await createSessionForGitHubUser(env, { login: "jsonbored", id: 42 }, {
      githubToken: "near-expiry-token",
      githubTokenExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      githubRefreshToken: "refresh-token",
      githubRefreshTokenExpiresAt: new Date(Date.now() + 180 * 24 * 60 * 60_000).toISOString(),
    });
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await expect(getLiveSessionGitHubToken(env, session.id)).resolves.toBeNull();
  });

  it("getDecryptedSessionGitHubTokenBundle degrades the refresh half only, keeping the access token usable, when the refresh ciphertext is corrupt", async () => {
    const env = createTestEnv({ TOKEN_ENCRYPTION_SECRET: SECRET });
    const { session } = await createSessionForGitHubUser(env, { login: "jsonbored", id: 42 }, {
      githubToken: "access-token-ok",
      githubRefreshToken: "refresh-token-ok",
    });
    await env.DB.prepare("update auth_session_github_tokens set refresh_ciphertext = ? where session_id = ?").bind("corrupted-not-real-ciphertext", session.id).run();
    const bundle = await getDecryptedSessionGitHubTokenBundle(env, session.id);
    expect(bundle?.accessToken).toBe("access-token-ok");
    expect(bundle?.refreshToken).toBeNull();
  });

  it("getDecryptedSessionGitHubTokenBundle returns null when no encryption key is configured", async () => {
    const env = createTestEnv({ TOKEN_ENCRYPTION_SECRET: SECRET });
    const { session } = await createSessionForGitHubUser(env, { login: "jsonbored", id: 42 }, { githubToken: "some-token" });
    const noSecretEnv = { ...env, TOKEN_ENCRYPTION_SECRET: undefined } as unknown as Env;
    await expect(getDecryptedSessionGitHubTokenBundle(noSecretEnv, session.id)).resolves.toBeNull();
  });

  it("getDecryptedSessionGitHubTokenBundle returns null (whole bundle, not just the refresh half) when the ACCESS token ciphertext fails to decrypt", async () => {
    const env = createTestEnv({ TOKEN_ENCRYPTION_SECRET: SECRET });
    const { session } = await createSessionForGitHubUser(env, { login: "jsonbored", id: 42 }, { githubToken: "some-token", githubRefreshToken: "some-refresh-token" });
    const wrongSecretEnv = { ...env, TOKEN_ENCRYPTION_SECRET: "totally-different-example-secret-32-bytes-min" } as unknown as Env;
    await expect(getDecryptedSessionGitHubTokenBundle(wrongSecretEnv, session.id)).resolves.toBeNull();
  });
});

describe("POST /v1/auth/github/token route (#6114)", () => {
  it("returns the session's live GitHub token, never cached", async () => {
    const app = createApp();
    const env = createTestEnv({ TOKEN_ENCRYPTION_SECRET: SECRET });
    const { token } = await createSessionForGitHubUser(env, { login: "jsonbored", id: 42 }, { githubToken: "gh-token-abc123" });
    const res = await app.request("/v1/auth/github/token", { method: "POST", headers: { cookie: `loopover_session=${token}` } }, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ token: "gh-token-abc123" });
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("returns 404 github_token_unavailable when no token was persisted for this session", async () => {
    const app = createApp();
    const env = createTestEnv({ TOKEN_ENCRYPTION_SECRET: SECRET });
    const { token } = await createSessionForGitHubUser(env, { login: "jsonbored", id: 42 });
    const res = await app.request("/v1/auth/github/token", { method: "POST", headers: { cookie: `loopover_session=${token}` } }, env);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "github_token_unavailable" });
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("rejects unauthenticated access", async () => {
    const app = createApp();
    const env = createTestEnv({ TOKEN_ENCRYPTION_SECRET: SECRET });
    const res = await app.request("/v1/auth/github/token", { method: "POST" }, env);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "browser_session_required" });
  });

  it("rejects the static mcp/api shared-secret identities -- session-only, since they represent no single logged-in GitHub user", async () => {
    const app = createApp();
    const env = createTestEnv({ TOKEN_ENCRYPTION_SECRET: SECRET });
    const apiRes = await app.request("/v1/auth/github/token", { method: "POST", headers: { authorization: `Bearer ${env.LOOPOVER_API_TOKEN}` } }, env);
    expect(apiRes.status).toBe(403);
    const mcpRes = await app.request("/v1/auth/github/token", { method: "POST", headers: { authorization: `Bearer ${env.LOOPOVER_MCP_TOKEN}` } }, env);
    expect(mcpRes.status).toBe(403);
  });

  it("records product-usage telemetry without ever including the token", async () => {
    const app = createApp();
    const env = createTestEnv({ TOKEN_ENCRYPTION_SECRET: SECRET });
    const { token } = await createSessionForGitHubUser(env, { login: "jsonbored", id: 42 }, { githubToken: "super-secret-value" });
    const res = await app.request(
      "/v1/auth/github/token",
      { method: "POST", headers: { cookie: `loopover_session=${token}`, "x-loopover-mcp-client": "test" } },
      env,
    );
    expect(res.status).toBe(200);
    const events = await env.DB.prepare("select * from product_usage_events where event_name = ?").bind("github_token_fetched").all();
    expect(events.results.length).toBeGreaterThan(0);
    expect(JSON.stringify(events.results)).not.toContain("super-secret-value");
  });
});
