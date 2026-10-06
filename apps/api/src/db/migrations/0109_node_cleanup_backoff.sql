ALTER TABLE nodes ADD COLUMN cleanup_backoff_until TEXT;

CREATE INDEX IF NOT EXISTS idx_nodes_cleanup_backoff_until
  ON nodes(cleanup_backoff_until);
