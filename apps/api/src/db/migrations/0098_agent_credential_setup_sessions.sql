-- Guided agent credential setup sessions (Cloudflare Sandbox terminal login).
-- Ephemeral: rows are short-lived (TTL ~10-15 min) and swept. Additive only.
--
-- SECURITY: This table MUST NEVER store any captured credential or secret
-- material. The captured auth.json is read server-side inside the sandbox,
-- validated, encrypted, and persisted via the normal credentials path — it does
-- not pass through this table. Only non-secret lifecycle metadata lives here.
--
-- Idempotent (IF NOT EXISTS): this migration was renumbered 0097 -> 0098 after a
-- staging deploy had already applied it as 0097; the guards let the renamed file
-- re-apply cleanly on that database while still creating everything fresh in prod.

CREATE TABLE IF NOT EXISTS agent_credential_setup_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  scope TEXT NOT NULL DEFAULT 'user',
  agent_type TEXT NOT NULL,
  credential_kind TEXT NOT NULL DEFAULT 'oauth-token',
  status TEXT NOT NULL DEFAULT 'creating',
  sandbox_id TEXT NOT NULL,
  pool_lease_id TEXT,
  error_code TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  started_at TEXT,
  expires_at TEXT NOT NULL,
  completed_at TEXT
);

-- Enforce a single ACTIVE setup session per (user, agent_type). Terminal-status
-- rows (completed/failed/cancelled/expired) are excluded so a user can always
-- retry after a prior attempt finishes.
CREATE UNIQUE INDEX IF NOT EXISTS idx_acss_one_active
  ON agent_credential_setup_sessions(user_id, agent_type)
  WHERE status IN ('creating', 'admitting', 'provisioning', 'waiting_for_user', 'capturing', 'saving');

-- Cron sweep: expired non-terminal sessions needing teardown.
CREATE INDEX IF NOT EXISTS idx_acss_sweep
  ON agent_credential_setup_sessions(status, expires_at);

-- User-scoped listing / status lookups.
CREATE INDEX IF NOT EXISTS idx_acss_user
  ON agent_credential_setup_sessions(user_id, created_at DESC);
