-- Migration: Add first-class task/session correlation to platform errors.
-- Additive only: existing error rows remain valid with NULL correlation IDs.

ALTER TABLE platform_errors ADD COLUMN task_id TEXT;
ALTER TABLE platform_errors ADD COLUMN session_id TEXT;

CREATE INDEX IF NOT EXISTS idx_platform_errors_task_id ON platform_errors (task_id);
CREATE INDEX IF NOT EXISTS idx_platform_errors_session_id ON platform_errors (session_id);
CREATE INDEX IF NOT EXISTS idx_platform_errors_node_id ON platform_errors (node_id);
CREATE INDEX IF NOT EXISTS idx_platform_errors_workspace_id ON platform_errors (workspace_id);
