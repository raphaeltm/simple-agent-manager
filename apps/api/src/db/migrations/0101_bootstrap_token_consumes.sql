CREATE TABLE IF NOT EXISTS bootstrap_token_consumes (
  token_hash TEXT PRIMARY KEY NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_bootstrap_token_consumes_expiry ON bootstrap_token_consumes(expires_at);
CREATE INDEX IF NOT EXISTS idx_bootstrap_token_consumes_consumed ON bootstrap_token_consumes(consumed_at);
