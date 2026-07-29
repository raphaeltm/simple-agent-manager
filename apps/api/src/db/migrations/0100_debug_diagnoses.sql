CREATE TABLE IF NOT EXISTS debug_diagnoses (
  id TEXT PRIMARY KEY NOT NULL,
  error_id TEXT,
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  diagnosis TEXT NOT NULL,
  model TEXT NOT NULL,
  turns INTEGER NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  daily_tokens_used INTEGER NOT NULL,
  daily_token_limit INTEGER NOT NULL,
  idea_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  created_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_debug_diagnoses_error_created ON debug_diagnoses(error_id, created_at);
CREATE INDEX IF NOT EXISTS idx_debug_diagnoses_window ON debug_diagnoses(start_time, end_time);
