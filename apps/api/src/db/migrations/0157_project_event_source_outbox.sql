-- Persistent producer-side admission intents for wake-critical project events.
--
-- This table is D1-owned because the authoritative source transition for task
-- lifecycle events also lives in D1. ProjectData remains the canonical event
-- store; this table is only a bounded retry/outcome ledger for producers before
-- they cross into ProjectData admission.

CREATE TABLE project_event_source_outbox (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  source TEXT NOT NULL,
  event_type TEXT NOT NULL,
  subject_type TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  delivery_key TEXT NOT NULL,
  payload_fingerprint TEXT NOT NULL,
  event_payload_json TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN (
    'pending',
    'processing',
    'retryable_failed',
    'admitted',
    'expired',
    'permanent_failed'
  )),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  max_attempts INTEGER NOT NULL CHECK (max_attempts > 0),
  next_attempt_at TEXT NOT NULL,
  processing_lease_expires_at TEXT,
  expires_at TEXT NOT NULL,
  admitted_event_id TEXT,
  admission_outcome TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX idx_project_event_source_outbox_delivery
  ON project_event_source_outbox(project_id, source, delivery_key);

CREATE INDEX idx_project_event_source_outbox_due
  ON project_event_source_outbox(state, next_attempt_at, id);

CREATE INDEX idx_project_event_source_outbox_processing_lease
  ON project_event_source_outbox(state, processing_lease_expires_at, id);

CREATE INDEX idx_project_event_source_outbox_project_subject
  ON project_event_source_outbox(project_id, subject_type, subject_id, state);
