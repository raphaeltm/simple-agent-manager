-- Add unique index on chat_session_id (nullable unique — only enforces when non-null).
-- Prevents multiple workspaces from sharing the same chat session, which causes
-- non-deterministic routing of follow-up messages.
CREATE UNIQUE INDEX IF NOT EXISTS idx_workspaces_chat_session_id_unique
  ON workspaces(chat_session_id) WHERE chat_session_id IS NOT NULL;
