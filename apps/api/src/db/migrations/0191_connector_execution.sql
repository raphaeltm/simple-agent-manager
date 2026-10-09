-- Atomic user budgets; one row per user and budget, reset in-place.
CREATE TABLE connector_rate_limits (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  budget TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  used INTEGER NOT NULL,
  PRIMARY KEY (user_id, budget)
);

-- Allowlisted metadata only: never retain prompts, answers, tokens or arbitrary inputs.
CREATE TABLE connector_operation_audit (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  via TEXT NOT NULL,
  client_id TEXT,
  client_name TEXT,
  operation TEXT NOT NULL,
  project_id TEXT,
  target_id TEXT,
  input_summary TEXT NOT NULL,
  result TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX connector_audit_user_created ON connector_operation_audit(user_id, created_at);
