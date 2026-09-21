-- Durable, lease-fenced progress for ProjectData archive copying.
--
-- A target chunk is the durable receipt. This checkpoint records the source cursor that
-- produced that receipt, so a reset resumes at the next immutable ordinal instead of replaying
-- every earlier R2 object. Rows are additive and do not change existing journal states.

CREATE TABLE project_data_archive_copy_checkpoints (
  migration_id TEXT NOT NULL
    REFERENCES project_data_archive_migrations(migration_id) ON DELETE CASCADE,
  table_name TEXT NOT NULL CHECK (
    table_name IN ('chat_messages', 'chat_messages_grouped', 'tool_payload_archives')
  ),
  storage_format TEXT NOT NULL CHECK (storage_format IN ('sqlite-v1', 'r2-gzip-v1')),
  chunk_rows INTEGER NOT NULL CHECK (chunk_rows > 0),
  chunk_bytes INTEGER NOT NULL CHECK (chunk_bytes > 0),
  next_ordinal INTEGER NOT NULL DEFAULT 0 CHECK (next_ordinal >= 0),
  source_cursor TEXT,
  complete INTEGER NOT NULL DEFAULT 0 CHECK (complete IN (0, 1)),
  copied_rows INTEGER NOT NULL DEFAULT 0 CHECK (copied_rows >= 0),
  copied_bytes INTEGER NOT NULL DEFAULT 0 CHECK (copied_bytes >= 0),
  last_chunk_sha256 TEXT,
  lease_epoch INTEGER NOT NULL DEFAULT 0 CHECK (lease_epoch >= 0),
  last_operation TEXT,
  last_operation_id TEXT,
  last_operation_started_at INTEGER,
  last_operation_completed_at INTEGER,
  last_operation_duration_ms INTEGER CHECK (
    last_operation_duration_ms IS NULL OR last_operation_duration_ms >= 0
  ),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (migration_id, table_name)
);

CREATE INDEX idx_project_data_archive_copy_checkpoints_progress
  ON project_data_archive_copy_checkpoints(complete, updated_at, migration_id);
