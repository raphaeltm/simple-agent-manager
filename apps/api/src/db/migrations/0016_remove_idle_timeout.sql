-- Remove idle timeout infrastructure columns from workspaces table.
-- Idle-triggered auto-shutdown was disabled and is no longer used.
-- lastActivityAt is preserved for future stale-workspace detection.

-- SQLite does not support DROP COLUMN in older versions, but D1 uses
-- a modern SQLite that does support ALTER TABLE ... DROP COLUMN.
ALTER TABLE workspaces DROP COLUMN shutdown_deadline;
ALTER TABLE workspaces DROP COLUMN idle_timeout_seconds;
