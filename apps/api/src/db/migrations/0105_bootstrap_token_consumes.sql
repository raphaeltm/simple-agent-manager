CREATE TABLE IF NOT EXISTS bootstrap_token_consumes (
  token_hash TEXT PRIMARY KEY NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_bootstrap_token_consumes_expiry ON bootstrap_token_consumes(expires_at);
CREATE INDEX IF NOT EXISTS idx_bootstrap_token_consumes_consumed ON bootstrap_token_consumes(consumed_at);
