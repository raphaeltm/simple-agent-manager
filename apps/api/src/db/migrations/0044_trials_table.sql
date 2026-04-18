-- Trial records (spec: trial-onboarding-mvp, Wave 1 Track A).
--
-- One row per anonymous trial. The row is created by POST /api/trial/create
-- BEFORE the project is provisioned — projectId is populated by the SSE
-- orchestrator (Track B) once the project row exists in `projects`.
--
-- Rows are never physically deleted during normal operation (status transitions
-- to 'expired' after TRIAL_WORKSPACE_TTL_MS and to 'claimed' when the visitor
-- completes GitHub OAuth). A daily retention cron deletes rows older than
-- TRIAL_DATA_RETENTION_HOURS in Wave 2.

-- =============================================================================
-- trials
-- =============================================================================
-- Status state machine:
--   pending  -> ready | failed | expired
--   ready    -> claimed | expired
--   failed   -> (terminal)
--   expired  -> (terminal; reaped by retention cron)
--   claimed  -> (terminal; project is now owned by the claimant user)
CREATE TABLE IF NOT EXISTS trials (
  id TEXT PRIMARY KEY NOT NULL,
  -- The anonymous visitor fingerprint (UUID), matches the cookie payload.
  -- Different trials for the same visitor share the same fingerprint.
  fingerprint TEXT NOT NULL,
  -- Canonicalised https://github.com/owner/repo (no .git, no trailing /).
  repo_url TEXT NOT NULL,
  -- GitHub repo identity, captured at create time for fast status queries
  -- and claim validation.
  repo_owner TEXT NOT NULL,
  repo_name TEXT NOT NULL,
  -- 'YYYY-MM' (UTC). Matches TrialCounter keyspace — used for decrement
  -- on failure and for monthly rollover audit.
  month_key TEXT NOT NULL,
  -- pending | ready | failed | expired | claimed
  status TEXT NOT NULL DEFAULT 'pending',
  -- Populated by the SSE track once the project row exists in `projects`.
  -- Nullable: trial can fail before project creation.
  project_id TEXT,
  -- Populated by POST /api/trial/claim after GitHub OAuth completes.
  claimed_by_user_id TEXT,
  created_at INTEGER NOT NULL,   -- epoch ms
  expires_at INTEGER NOT NULL,   -- epoch ms (createdAt + TRIAL_WORKSPACE_TTL_MS)
  claimed_at INTEGER,            -- epoch ms, nullable
  -- Free-text error code persisted when status='failed' (e.g. 'repo_not_found').
  error_code TEXT,
  error_message TEXT
);

-- Fast status lookup by fingerprint (e.g. re-opening the trial page).
CREATE INDEX IF NOT EXISTS idx_trials_fingerprint
  ON trials (fingerprint, created_at);

-- Used by the stale-trial expiry cron.
CREATE INDEX IF NOT EXISTS idx_trials_status_expiry
  ON trials (status, expires_at);

-- Used by the monthly rollover audit.
CREATE INDEX IF NOT EXISTS idx_trials_month_key_status
  ON trials (month_key, status);
