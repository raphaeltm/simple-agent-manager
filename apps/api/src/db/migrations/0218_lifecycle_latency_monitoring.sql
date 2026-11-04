-- Lifecycle latency monitoring (tasks/active/2026-11-04-lifecycle-latency-monitoring.md).
-- Status columns have many writers across routes, Durable Objects and sweeps, so the time a
-- row entered its current state, and the history of transitions, are recorded here at the
-- storage layer instead of at each writer. Every trigger is a single statement.

ALTER TABLE workspaces ADD COLUMN status_changed_at TEXT;
ALTER TABLE nodes ADD COLUMN status_changed_at TEXT;
ALTER TABLE session_snapshots ADD COLUMN sleep_status_changed_at TEXT;
ALTER TABLE session_snapshots ADD COLUMN recovery_status_changed_at TEXT;

-- One row per status change. entered_at is when from_status was entered (NULL when that is
-- unknown, e.g. rows that predate this migration), so changed_at - entered_at is the time spent
-- in from_status. Purged by the daily retention job.
CREATE TABLE lifecycle_state_transitions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  from_status TEXT,
  to_status TEXT,
  entered_at TEXT,
  changed_at TEXT NOT NULL
);
CREATE INDEX idx_lifecycle_state_transitions_state_changed
  ON lifecycle_state_transitions (entity_type, from_status, changed_at);
CREATE INDEX idx_lifecycle_state_transitions_changed
  ON lifecycle_state_transitions (changed_at);

-- One row per alerted episode: the watchdog alerts at most once per entity, state and entry time.
CREATE TABLE lifecycle_latency_alerts (
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  status TEXT NOT NULL,
  entered_at TEXT NOT NULL,
  alerted_at TEXT NOT NULL,
  PRIMARY KEY (entity_type, entity_id, status, entered_at)
);
CREATE INDEX idx_lifecycle_latency_alerts_alerted ON lifecycle_latency_alerts (alerted_at);

CREATE INDEX idx_workspaces_status_changed_at ON workspaces (status, status_changed_at);
CREATE INDEX idx_nodes_status_changed_at ON nodes (status, status_changed_at);
CREATE INDEX idx_session_snapshots_sleep_status_changed_at
  ON session_snapshots (sleep_status, sleep_status_changed_at);
CREATE INDEX idx_session_snapshots_recovery_status_changed_at
  ON session_snapshots (recovery_status, recovery_status_changed_at);

-- Backfill only rows in a non-terminal state. updated_at is the best available approximation of
-- when they entered it; rows already terminal never need a state age. strftime normalizes every
-- source format (including SQLite's CURRENT_TIMESTAMP) to the ISO form the watchdog compares as text.
UPDATE workspaces SET status_changed_at = strftime('%Y-%m-%dT%H:%M:%fZ', COALESCE(updated_at, created_at))
WHERE status_changed_at IS NULL AND status NOT IN ('deleted', 'error');
UPDATE nodes SET status_changed_at = strftime('%Y-%m-%dT%H:%M:%fZ', COALESCE(updated_at, created_at))
WHERE status_changed_at IS NULL AND status NOT IN ('deleted', 'error');
UPDATE session_snapshots SET sleep_status_changed_at = strftime('%Y-%m-%dT%H:%M:%fZ', COALESCE(sleep_claimed_at, updated_at, created_at))
WHERE sleep_status_changed_at IS NULL AND sleep_status IN ('preparing', 'stopping');
UPDATE session_snapshots SET recovery_status_changed_at = strftime('%Y-%m-%dT%H:%M:%fZ', COALESCE(recovery_claimed_at, updated_at, created_at))
WHERE recovery_status_changed_at IS NULL AND recovery_status = 'waking';
