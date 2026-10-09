-- Receipts never expire into a replayable key. Only intent hashes and bounded
-- successful receipts are retained; prompts and credentials are not stored.
CREATE TABLE IF NOT EXISTS cli_operation_receipts (
  receipt_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  intent_hash TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending','completed')),
  response_json TEXT,
  response_status INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
