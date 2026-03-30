-- Add UNIQUE constraint on token_hash to prevent duplicate tokens.
-- The hash index from 0033 is replaced with a unique index.
DROP INDEX IF EXISTS idx_smoke_test_tokens_hash;
CREATE UNIQUE INDEX idx_smoke_test_tokens_hash ON smoke_test_tokens(token_hash);
