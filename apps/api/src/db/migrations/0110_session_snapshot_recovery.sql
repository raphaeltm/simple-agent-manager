-- Durable sleep/wake ownership for runtime-neutral session snapshots.
ALTER TABLE session_snapshots ADD COLUMN sleeping_at TEXT;
ALTER TABLE session_snapshots ADD COLUMN recovery_status TEXT;
ALTER TABLE session_snapshots ADD COLUMN recovery_task_id TEXT;
ALTER TABLE session_snapshots ADD COLUMN recovery_workspace_id TEXT REFERENCES workspaces(id) ON DELETE SET NULL;
ALTER TABLE session_snapshots ADD COLUMN recovery_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE session_snapshots ADD COLUMN recovery_error TEXT;
ALTER TABLE session_snapshots ADD COLUMN recovery_claimed_at TEXT;
ALTER TABLE session_snapshots ADD COLUMN sleep_status TEXT;
ALTER TABLE session_snapshots ADD COLUMN sleep_after TEXT;
ALTER TABLE session_snapshots ADD COLUMN sleep_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE session_snapshots ADD COLUMN sleep_error TEXT;
ALTER TABLE session_snapshots ADD COLUMN sleep_claim_id TEXT;
ALTER TABLE session_snapshots ADD COLUMN sleep_claimed_at TEXT;
ALTER TABLE session_snapshots ADD COLUMN snapshot_generation TEXT;
ALTER TABLE session_snapshots ADD COLUMN capture_generation TEXT;
ALTER TABLE session_snapshots ADD COLUMN home_sha256 TEXT;
ALTER TABLE session_snapshots ADD COLUMN wip_sha256 TEXT;

CREATE INDEX idx_session_snapshots_recovery_status
  ON session_snapshots(recovery_status, expires_at);

CREATE INDEX idx_session_snapshots_recovery_claim
  ON session_snapshots(recovery_status, recovery_claimed_at);

CREATE INDEX idx_session_snapshots_sleep_due
  ON session_snapshots(sleep_status, sleep_after);

CREATE INDEX idx_session_snapshots_sleep_claim
  ON session_snapshots(sleep_status, sleep_claimed_at);

CREATE INDEX idx_session_snapshots_sleep_expiry
  ON session_snapshots(sleep_status, expires_at);
