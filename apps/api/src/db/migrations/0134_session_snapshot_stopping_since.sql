ALTER TABLE session_snapshots ADD COLUMN sleep_stopping_since TEXT;

UPDATE session_snapshots
   SET sleep_stopping_since = COALESCE(sleep_claimed_at, updated_at, created_at)
 WHERE sleep_status = 'stopping'
   AND sleeping_at IS NULL
   AND sleep_stopping_since IS NULL;

CREATE INDEX idx_session_snapshots_sleep_stopping_since
  ON session_snapshots(sleep_status, sleep_stopping_since);
