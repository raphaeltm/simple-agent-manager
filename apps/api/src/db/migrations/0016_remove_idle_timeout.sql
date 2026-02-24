-- Remove idle timeout columns (feature was disabled and removed).
-- D1 uses modern SQLite (3.35.0+) which supports DROP COLUMN.
ALTER TABLE workspaces DROP COLUMN shutdown_deadline;
ALTER TABLE workspaces DROP COLUMN idle_timeout_seconds;
