-- Preserve the source-task identity when a sleeping conversation hands its
-- unique chat-session binding to a replacement recovery task.
ALTER TABLE tasks ADD COLUMN recovery_source_task_id TEXT;

CREATE INDEX idx_tasks_recovery_source_task_id
  ON tasks(recovery_source_task_id)
  WHERE recovery_source_task_id IS NOT NULL;
