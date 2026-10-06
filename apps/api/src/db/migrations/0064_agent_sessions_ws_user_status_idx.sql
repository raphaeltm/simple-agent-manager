-- Create the composite index backing the tenant-scoped agent-session lookup in
-- routes/chat.ts (the /prompt and /cancel handlers filter agent_sessions by
-- workspace_id + user_id + status='running' for defence-in-depth IDOR scoping).
--
-- The index is declared in schema.ts (idx_agent_sessions_ws_user_status) but no
-- prior migration ever created it, so production D1 was falling back to the
-- single-column workspace_id index and re-filtering user_id/status in memory.
-- This migration brings production in line with the schema definition.
--
-- Safe: additive CREATE INDEX IF NOT EXISTS — no data mutation, no DROP/DELETE.
CREATE INDEX IF NOT EXISTS idx_agent_sessions_ws_user_status
  ON agent_sessions(workspace_id, user_id, status);
