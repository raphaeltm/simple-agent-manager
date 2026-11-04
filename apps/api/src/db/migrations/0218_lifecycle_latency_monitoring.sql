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

-- Workspaces
CREATE TRIGGER trg_workspaces_status_transition
AFTER UPDATE OF status ON workspaces
WHEN NEW.status IS NOT OLD.status
BEGIN INSERT INTO lifecycle_state_transitions (entity_type, entity_id, from_status, to_status, entered_at, changed_at) VALUES ('workspace', NEW.id, OLD.status, NEW.status, OLD.status_changed_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')); END;

CREATE TRIGGER trg_workspaces_status_changed_at
AFTER UPDATE OF status ON workspaces
WHEN NEW.status IS NOT OLD.status
BEGIN UPDATE workspaces SET status_changed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id; END;

CREATE TRIGGER trg_workspaces_status_changed_at_insert
AFTER INSERT ON workspaces
WHEN NEW.status_changed_at IS NULL
BEGIN UPDATE workspaces SET status_changed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id; END;

-- Nodes
CREATE TRIGGER trg_nodes_status_transition
AFTER UPDATE OF status ON nodes
WHEN NEW.status IS NOT OLD.status
BEGIN INSERT INTO lifecycle_state_transitions (entity_type, entity_id, from_status, to_status, entered_at, changed_at) VALUES ('node', NEW.id, OLD.status, NEW.status, OLD.status_changed_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')); END;

CREATE TRIGGER trg_nodes_status_changed_at
AFTER UPDATE OF status ON nodes
WHEN NEW.status IS NOT OLD.status
BEGIN UPDATE nodes SET status_changed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id; END;

CREATE TRIGGER trg_nodes_status_changed_at_insert
AFTER INSERT ON nodes
WHEN NEW.status_changed_at IS NULL
BEGIN UPDATE nodes SET status_changed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id; END;

-- Session sleep
CREATE TRIGGER trg_session_snapshots_sleep_status_transition
AFTER UPDATE OF sleep_status ON session_snapshots
WHEN NEW.sleep_status IS NOT OLD.sleep_status
BEGIN INSERT INTO lifecycle_state_transitions (entity_type, entity_id, from_status, to_status, entered_at, changed_at) VALUES ('session_sleep', NEW.id, OLD.sleep_status, NEW.sleep_status, OLD.sleep_status_changed_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')); END;

CREATE TRIGGER trg_session_snapshots_sleep_status_changed_at
AFTER UPDATE OF sleep_status ON session_snapshots
WHEN NEW.sleep_status IS NOT OLD.sleep_status
BEGIN UPDATE session_snapshots SET sleep_status_changed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id; END;

-- Session recovery (wake)
CREATE TRIGGER trg_session_snapshots_recovery_status_transition
AFTER UPDATE OF recovery_status ON session_snapshots
WHEN NEW.recovery_status IS NOT OLD.recovery_status
BEGIN INSERT INTO lifecycle_state_transitions (entity_type, entity_id, from_status, to_status, entered_at, changed_at) VALUES ('session_recovery', NEW.id, OLD.recovery_status, NEW.recovery_status, OLD.recovery_status_changed_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')); END;

CREATE TRIGGER trg_session_snapshots_recovery_status_changed_at
AFTER UPDATE OF recovery_status ON session_snapshots
WHEN NEW.recovery_status IS NOT OLD.recovery_status
BEGIN UPDATE session_snapshots SET recovery_status_changed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id; END;

CREATE TRIGGER trg_session_snapshots_status_changed_at_insert
AFTER INSERT ON session_snapshots
WHEN NEW.sleep_status IS NOT NULL OR NEW.recovery_status IS NOT NULL
BEGIN UPDATE session_snapshots SET sleep_status_changed_at = CASE WHEN NEW.sleep_status IS NULL THEN NULL ELSE COALESCE(NEW.sleep_status_changed_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) END, recovery_status_changed_at = CASE WHEN NEW.recovery_status IS NULL THEN NULL ELSE COALESCE(NEW.recovery_status_changed_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) END WHERE id = NEW.id; END;

-- Backfill only rows in a non-terminal state. updated_at is the best available approximation of
-- when they entered it; rows already terminal never need a state age.
UPDATE workspaces SET status_changed_at = COALESCE(updated_at, created_at)
WHERE status_changed_at IS NULL AND status NOT IN ('deleted', 'error');
UPDATE nodes SET status_changed_at = COALESCE(updated_at, created_at)
WHERE status_changed_at IS NULL AND status NOT IN ('deleted', 'error');
UPDATE session_snapshots SET sleep_status_changed_at = COALESCE(sleep_claimed_at, updated_at, created_at)
WHERE sleep_status_changed_at IS NULL AND sleep_status IN ('preparing', 'stopping');
UPDATE session_snapshots SET recovery_status_changed_at = COALESCE(recovery_claimed_at, updated_at, created_at)
WHERE recovery_status_changed_at IS NULL AND recovery_status = 'waking';
