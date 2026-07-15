-- Refresh/expiration for the session GitHub token (#6115). GitHub App user-to-server tokens expire 8h after
-- issue by default (a `refresh_token` valid 6 months is issued alongside, unless the App owner opted OUT of
-- token expiration entirely -- see GitHub's own docs: "Refreshing user access tokens"). AMS runs can outlive
-- 8h, so the stored access token alone (added in #6114 / migrations/0153) isn't enough on its own for a
-- long-running session. All columns are nullable: existing #6114 rows predate this migration (no expiry/refresh
-- info was ever captured for them), and even a fresh row may have no refresh_token if a specific token-exchange
-- response never included one (e.g. the /v1/auth/github/session caller-supplied-token path, which never went
-- through our own device/web OAuth exchange) -- getLiveSessionGitHubToken (src/auth/github-oauth.ts) treats an
-- absent expires_at as "never expires" for backward compatibility with those rows.
ALTER TABLE auth_session_github_tokens ADD COLUMN expires_at TEXT;
ALTER TABLE auth_session_github_tokens ADD COLUMN refresh_ciphertext TEXT;
ALTER TABLE auth_session_github_tokens ADD COLUMN refresh_iv TEXT;
ALTER TABLE auth_session_github_tokens ADD COLUMN refresh_salt TEXT;
ALTER TABLE auth_session_github_tokens ADD COLUMN refresh_key_version INTEGER;
ALTER TABLE auth_session_github_tokens ADD COLUMN refresh_expires_at TEXT;
