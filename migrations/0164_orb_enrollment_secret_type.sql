-- Loopover Orb token-broker (#7174) — a discriminator so an enrollment row can eventually carry more than a
-- GitHub installation token (AI-provider keys, DB credentials for the hosted control-plane's provisioning core,
-- #7173). Every existing and default-issued row is 'github_token', so brokerOrbToken's behavior is unchanged for
-- every current caller; the column exists purely so a future mint strategy can be selected per row instead of
-- assumed.
ALTER TABLE orb_enrollments ADD COLUMN secret_type TEXT NOT NULL DEFAULT 'github_token';
