-- Trial onboarding foundation (spec: trial-onboarding-mvp).
--
-- Seeds a sentinel "system" user that owns anonymous trial projects until a visitor
-- claims them via GitHub OAuth. Using a real row in `users` avoids NULL-handling
-- everywhere that FKs `projects.user_id`.
--
-- Also creates the waitlist table backing POST /api/trial/waitlist (users who were
-- blocked by the monthly cap).

-- =============================================================================
-- System user seed
-- =============================================================================
-- NOTE: id `system_anonymous_trials` is the sentinel constant exported from
--       @simple-agent-manager/shared as TRIAL_ANONYMOUS_USER_ID. Never log in
--       as this user. `status = 'system'` keeps it out of the 'active' admin
--       list filter; the unfiltered admin query will still surface it and will
--       be filtered in Wave 1+ UI polish.
INSERT INTO users (id, email, email_verified, role, status)
VALUES (
  'system_anonymous_trials',
  'anonymous-trials@simple-agent-manager.internal',
  0,
  'user',
  'system'
)
ON CONFLICT(id) DO NOTHING;

-- =============================================================================
-- Waitlist (cap-exceeded signups)
-- =============================================================================
-- One row per (email, resetDate). resetDate is the ISO date of the month boundary
-- when the user's queued slot becomes eligible again (YYYY-MM-01, UTC). Once the
-- notification is sent, notified_at is stamped.
CREATE TABLE IF NOT EXISTS trial_waitlist (
  id TEXT PRIMARY KEY NOT NULL,
  email TEXT NOT NULL,
  submitted_at INTEGER NOT NULL,   -- epoch ms
  reset_date TEXT NOT NULL,        -- 'YYYY-MM-01' (UTC)
  notified_at INTEGER              -- epoch ms, nullable
);

-- Dedupe: one queued entry per email per reset window.
CREATE UNIQUE INDEX IF NOT EXISTS idx_trial_waitlist_email_reset
  ON trial_waitlist (email, reset_date);

-- Scan-by-reset-window lookups for the monthly notifier cron.
CREATE INDEX IF NOT EXISTS idx_trial_waitlist_reset_notify
  ON trial_waitlist (reset_date, notified_at);
