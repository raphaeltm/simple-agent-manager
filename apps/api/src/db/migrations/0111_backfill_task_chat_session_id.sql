-- Backfill missing task ↔ chat-session links from the server-written workspace
-- binding when the task/workspace relationship is unambiguous.
--
-- Safety:
-- - UPDATE has a restrictive WHERE predicate.
-- - No DELETE/DROP.
-- - Leaves ambiguous same-workspace task sets and absent workspace links untouched.
WITH unambiguous_workspace_task_links AS (
  SELECT
    t.id AS task_id,
    w.chat_session_id AS chat_session_id
  FROM tasks t
  INNER JOIN workspaces w
    ON w.id = t.workspace_id
   AND w.project_id = t.project_id
  WHERE t.chat_session_id IS NULL
    AND t.workspace_id IS NOT NULL
    AND w.chat_session_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM tasks same_workspace
      WHERE same_workspace.id != t.id
        AND same_workspace.project_id = t.project_id
        AND same_workspace.workspace_id = t.workspace_id
        AND same_workspace.chat_session_id IS NULL
    )
    AND NOT EXISTS (
      SELECT 1
      FROM tasks existing_session_owner
      WHERE existing_session_owner.id != t.id
        AND existing_session_owner.chat_session_id = w.chat_session_id
    )
)
UPDATE tasks
SET
  chat_session_id = (
    SELECT chat_session_id
    FROM unambiguous_workspace_task_links
    WHERE task_id = tasks.id
  ),
  updated_at = CURRENT_TIMESTAMP
WHERE id IN (
  SELECT task_id
  FROM unambiguous_workspace_task_links
);
