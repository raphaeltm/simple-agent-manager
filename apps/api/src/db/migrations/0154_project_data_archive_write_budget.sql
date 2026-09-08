-- Installation-wide admission pool for compact archive attempts. No history scan or per-tick reset.
CREATE TABLE project_data_archive_write_budget (
  id TEXT PRIMARY KEY CHECK (id = 'global'),
  window_started_at INTEGER NOT NULL,
  reserved_writes INTEGER NOT NULL CHECK (reserved_writes >= 0)
);

ALTER TABLE project_data_archive_migrations ADD COLUMN storage_format TEXT NOT NULL DEFAULT 'sqlite-v1';

-- Exactly-once release only for contenders that definitively never acquired work.
CREATE TABLE project_data_archive_unused_reservations (
  reservation_id TEXT PRIMARY KEY,
  window_started_at INTEGER NOT NULL,
  estimated_writes INTEGER NOT NULL,
  released INTEGER NOT NULL DEFAULT 0 CHECK (released IN (0, 1))
);
CREATE INDEX idx_archive_unused_reservation_window ON project_data_archive_unused_reservations(window_started_at);
