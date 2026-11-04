-- Lifecycle latency monitoring (tasks/active/2026-11-04-lifecycle-latency-monitoring.md).
-- The watchdog samples rows in transient states every five minutes instead of using triggers on
-- the status tables (see 0219: D1 counts trigger writes in meta.changes, which breaks the
-- `changes === 1` compare-and-sets on those tables). Both tables are written only by
-- `services/lifecycle-latency/watchdog.ts`.

-- Indexes left by the trigger draft where it was applied (staging); no-ops elsewhere. That draft's
-- status_changed_at columns and two empty tables also remain there, unused (columns cannot be
-- dropped conditionally and new migrations may not drop tables).
DROP INDEX IF EXISTS idx_workspaces_status_changed_at;
DROP INDEX IF EXISTS idx_nodes_status_changed_at;
DROP INDEX IF EXISTS idx_session_snapshots_sleep_status_changed_at;
DROP INDEX IF EXISTS idx_session_snapshots_recovery_status_changed_at;

-- One row per entity currently seen in a watched state. first_seen_at is the first sample that
-- saw it there (at most one sweep after it really entered). alerted_at makes the slow-state alert
-- at-most-once per episode. The row is removed, and an episode recorded, once the entity leaves.
CREATE TABLE lifecycle_state_observations (
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  status TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  alerted_at TEXT,
  PRIMARY KEY (entity_type, entity_id, status)
);
CREATE INDEX idx_lifecycle_state_observations_seen
  ON lifecycle_state_observations (entity_type, status, first_seen_at);

-- One row per finished episode that lasted at least one sample, for the daily percentile check.
-- Purged by the daily retention job.
CREATE TABLE lifecycle_state_episodes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  status TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  ended_at TEXT NOT NULL
);
CREATE INDEX idx_lifecycle_state_episodes_state_ended
  ON lifecycle_state_episodes (entity_type, status, ended_at);
CREATE INDEX idx_lifecycle_state_episodes_ended ON lifecycle_state_episodes (ended_at);
