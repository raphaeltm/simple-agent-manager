-- Add execution_step column to tasks for tracking where the task runner is during async execution.
-- This enables faster stuck-task detection and better debugging by persisting the last known step.
ALTER TABLE tasks ADD COLUMN execution_step TEXT;
