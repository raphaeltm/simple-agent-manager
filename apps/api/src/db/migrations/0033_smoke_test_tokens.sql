-- Smoke test auth tokens for CI authentication
-- Gated by SMOKE_TEST_AUTH_ENABLED env var
CREATE TABLE smoke_test_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (cast(unixepoch() * 1000 as integer)),
  last_used_at INTEGER,
  revoked_at INTEGER
);

CREATE INDEX idx_smoke_test_tokens_hash ON smoke_test_tokens(token_hash);
CREATE INDEX idx_smoke_test_tokens_user ON smoke_test_tokens(user_id);
