-- Add finalized_at column to tasks table.
-- Set on first successful git push + PR creation.
-- Guards against duplicate finalization from concurrent agent completion and idle cleanup paths.
ALTER TABLE tasks ADD COLUMN finalized_at TEXT;
