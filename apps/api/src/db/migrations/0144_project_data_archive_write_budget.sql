-- Account-wide admission pool for compact archive attempts. No history scan or per-tick reset.
CREATE TABLE project_data_archive_write_budget (
  id TEXT PRIMARY KEY CHECK (id = 'global'),
  window_started_at INTEGER NOT NULL,
  reserved_writes INTEGER NOT NULL CHECK (reserved_writes >= 0)
);

ALTER TABLE project_data_archive_migrations ADD COLUMN storage_format TEXT NOT NULL DEFAULT 'sqlite-v1';
