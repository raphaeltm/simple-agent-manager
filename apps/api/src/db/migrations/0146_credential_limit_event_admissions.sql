-- Credential limit event admission/outbox state.
--
-- The producer captures the conditional credential-window transition and the
-- immutable ProjectData event envelope in D1 before calling the ProjectData DO.
-- Pending/failed rows are retried opportunistically with the exact stored
-- envelope. Superseded rows are retained briefly for audit/debugging but are
-- not dispatched after a newer credential-window transition becomes current.

ALTER TABLE agent_sessions
  ADD COLUMN agent_credential_generation INTEGER NOT NULL DEFAULT 0
  CHECK (agent_credential_generation >= 0);

CREATE TABLE credential_limit_event_admissions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  credential_reference TEXT NOT NULL,
  window_type TEXT NOT NULL,
  event_source TEXT NOT NULL,
  delivery_key TEXT NOT NULL,
  payload_fingerprint TEXT NOT NULL,
  event_type TEXT NOT NULL,
  transition TEXT NOT NULL CHECK (transition IN ('warning', 'critical', 'rejected', 'reset')),
  observed_at INTEGER NOT NULL CHECK (observed_at >= 0),
  received_at INTEGER NOT NULL CHECK (received_at >= 0),
  event_payload_json TEXT NOT NULL,
  dispatch_state TEXT NOT NULL DEFAULT 'pending'
    CHECK (dispatch_state IN ('pending', 'delivered', 'failed', 'conflicted', 'superseded')),
  dispatch_outcome TEXT
    CHECK (
      dispatch_outcome IS NULL OR
      dispatch_outcome IN ('created', 'duplicate_replay', 'conflict', 'capacity', 'superseded')
    ),
  dispatch_attempts INTEGER NOT NULL DEFAULT 0 CHECK (dispatch_attempts >= 0),
  dispatch_error TEXT,
  next_attempt_at INTEGER,
  last_attempt_at INTEGER,
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
  expires_at INTEGER NOT NULL CHECK (expires_at >= 0),
  UNIQUE(project_id, event_source, delivery_key)
);

CREATE INDEX idx_credential_limit_admissions_project_credential
  ON credential_limit_event_admissions(project_id, credential_reference, window_type);

CREATE INDEX idx_credential_limit_admissions_retry
  ON credential_limit_event_admissions(next_attempt_at, created_at)
  WHERE dispatch_state IN ('pending', 'failed');

CREATE INDEX idx_credential_limit_admissions_expires
  ON credential_limit_event_admissions(expires_at);
