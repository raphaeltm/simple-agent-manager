ALTER TABLE debug_diagnosis_runs ADD COLUMN current_step TEXT;
ALTER TABLE debug_diagnosis_runs ADD COLUMN heartbeat_at TEXT;
ALTER TABLE debug_diagnosis_runs ADD COLUMN attempt INTEGER NOT NULL DEFAULT 0;
ALTER TABLE debug_diagnosis_runs ADD COLUMN executor_version TEXT NOT NULL DEFAULT 'diagnosis-runner-v1';
ALTER TABLE debug_diagnosis_runs ADD COLUMN cancel_requested_at TEXT;
ALTER TABLE debug_diagnosis_runs ADD COLUMN deadline_at TEXT;

CREATE TABLE IF NOT EXISTS debug_diagnosis_run_events (
  id TEXT PRIMARY KEY NOT NULL,
  run_id TEXT NOT NULL REFERENCES debug_diagnosis_runs(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL,
  step_key TEXT NOT NULL,
  event_type TEXT NOT NULL,
  status TEXT NOT NULL,
  source_name TEXT,
  arguments_preview TEXT,
  evidence_preview TEXT,
  result_count INTEGER,
  duration_ms INTEGER,
  retry_attempt INTEGER NOT NULL DEFAULT 0,
  error_code TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(run_id, step_key)
);
CREATE INDEX IF NOT EXISTS idx_debug_diagnosis_events_run_sequence ON debug_diagnosis_run_events(run_id, sequence);
CREATE INDEX IF NOT EXISTS idx_debug_diagnosis_runs_active_deadline ON debug_diagnosis_runs(status, deadline_at);
