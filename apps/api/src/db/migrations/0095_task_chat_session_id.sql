-- Bidirectional, idempotent identity link for D1 tasks and ProjectData chat sessions.
-- Nullable during the legacy compatibility and reconciliation window.
ALTER TABLE tasks ADD COLUMN chat_session_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_chat_session_id_unique
  ON tasks(chat_session_id) WHERE chat_session_id IS NOT NULL;
