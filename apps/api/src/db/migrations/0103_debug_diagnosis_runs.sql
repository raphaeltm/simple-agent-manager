CREATE TABLE IF NOT EXISTS debug_diagnosis_runs (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed')),
  error_id TEXT,
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  diagnosis_id TEXT REFERENCES debug_diagnoses(id) ON DELETE SET NULL,
  retry_of_run_id TEXT,
  model TEXT,
  turns INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  daily_tokens_used INTEGER NOT NULL DEFAULT 0,
  daily_token_limit INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  created_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  started_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_debug_diagnosis_runs_status_created ON debug_diagnosis_runs(status, created_at);
CREATE INDEX IF NOT EXISTS idx_debug_diagnosis_runs_error_created ON debug_diagnosis_runs(error_id, created_at);
CREATE INDEX IF NOT EXISTS idx_debug_diagnosis_runs_window ON debug_diagnosis_runs(start_time, end_time);
