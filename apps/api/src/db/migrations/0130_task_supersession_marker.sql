-- Explicitly record sleeping-session handoffs so active-agent counts do not
-- treat replaced predecessors as still active.
ALTER TABLE tasks ADD COLUMN superseded_by_task_id TEXT;

CREATE INDEX idx_tasks_superseded_by_task_id
  ON tasks(superseded_by_task_id)
  WHERE superseded_by_task_id IS NOT NULL;

-- Backfill historical session-recovery predecessors using the same family
-- semantics as task-runtime-liveness.loadTaskSupersession:
--   - same project,
--   - later session-recovery owner,
--   - root-collapsed sibling or direct-child lineage.
-- Only non-terminal, chat-unbound predecessors are backfilled. Terminal rows and
-- current chat owners remain untouched.
UPDATE tasks AS predecessor
   SET superseded_by_task_id = (
     SELECT owner.id
       FROM tasks AS owner
      WHERE owner.project_id = predecessor.project_id
        AND owner.id != predecessor.id
        AND owner.triggered_by = 'session-recovery'
        AND owner.created_at > predecessor.created_at
        AND (
          owner.id = COALESCE(predecessor.recovery_source_task_id, predecessor.id)
          OR owner.recovery_source_task_id = COALESCE(predecessor.recovery_source_task_id, predecessor.id)
          OR owner.recovery_source_task_id = predecessor.id
        )
      ORDER BY owner.created_at ASC, owner.id ASC
      LIMIT 1
   )
 WHERE predecessor.superseded_by_task_id IS NULL
   AND predecessor.chat_session_id IS NULL
   AND predecessor.status NOT IN ('completed', 'failed', 'cancelled')
   AND EXISTS (
     SELECT 1
       FROM tasks AS owner
      WHERE owner.project_id = predecessor.project_id
        AND owner.id != predecessor.id
        AND owner.triggered_by = 'session-recovery'
        AND owner.created_at > predecessor.created_at
        AND (
          owner.id = COALESCE(predecessor.recovery_source_task_id, predecessor.id)
          OR owner.recovery_source_task_id = COALESCE(predecessor.recovery_source_task_id, predecessor.id)
          OR owner.recovery_source_task_id = predecessor.id
        )
   );
