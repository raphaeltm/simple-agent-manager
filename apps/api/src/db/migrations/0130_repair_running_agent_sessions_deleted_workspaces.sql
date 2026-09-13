-- Historical ledger backfill for agent_sessions rows left running after their
-- workspace row was already deleted. The workspace lifecycle finalizer owns new
-- closures; this migration drains the finite pre-finalizer backlog without
-- removing rows or changing task status.

UPDATE agent_sessions
   SET status = CASE
       WHEN EXISTS (
         SELECT 1
           FROM tasks failed_task
          WHERE failed_task.workspace_id = agent_sessions.workspace_id
            AND failed_task.status = 'failed'
       )
       THEN 'failed'
       WHEN EXISTS (
         SELECT 1
           FROM tasks completed_task
          WHERE completed_task.workspace_id = agent_sessions.workspace_id
            AND completed_task.status = 'completed'
       )
       THEN 'completed'
       ELSE 'stopped'
     END,
     stopped_at = COALESCE(stopped_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
     updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
 WHERE status = 'running'
   AND EXISTS (
     SELECT 1
       FROM workspaces
      WHERE workspaces.id = agent_sessions.workspace_id
        AND workspaces.status = 'deleted'
   );
