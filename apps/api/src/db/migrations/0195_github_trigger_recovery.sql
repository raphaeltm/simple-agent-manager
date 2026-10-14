-- Additive only: old audit records remain terminal dedup evidence; no historical replay.
CREATE TABLE github_trigger_inbox (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  payload_json TEXT,
  state TEXT NOT NULL CHECK (state IN ('pending', 'processing', 'completed', 'exhausted')),
  attempts INTEGER NOT NULL DEFAULT 0,
  available_at TEXT NOT NULL,
  lease_token TEXT,
  lease_until TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX idx_github_trigger_inbox_due ON github_trigger_inbox(state, available_at);
CREATE INDEX idx_github_trigger_inbox_expiry ON github_trigger_inbox(expires_at);
ALTER TABLE trigger_executions ADD COLUMN github_delivery_id TEXT;
ALTER TABLE trigger_executions ADD COLUMN submission_recorded_at TEXT;
ALTER TABLE trigger_executions ADD COLUMN admission_snapshot_json TEXT;
CREATE UNIQUE INDEX idx_trigger_execution_github_delivery
  ON trigger_executions(github_delivery_id, trigger_id) WHERE github_delivery_id IS NOT NULL;
