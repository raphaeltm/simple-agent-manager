-- Skip markers for bounded D1 session_summaries terminal-ledger repair.
-- ProjectData DO rows remain authoritative; these columns only prevent
-- live-head, snapshot-protected, or transiently ineligible D1 index rows from
-- being selected on every cron sweep.

ALTER TABLE session_summaries ADD COLUMN terminal_reconcile_deferred_until INTEGER;
ALTER TABLE session_summaries ADD COLUMN terminal_reconcile_defer_reason TEXT;

CREATE INDEX IF NOT EXISTS idx_session_summaries_terminal_reconcile
  ON session_summaries(status, terminal_reconcile_deferred_until, updated_at, id);
