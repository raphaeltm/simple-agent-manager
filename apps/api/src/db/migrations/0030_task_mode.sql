-- Add task_mode column to distinguish task vs conversation lifecycle
ALTER TABLE tasks ADD COLUMN task_mode TEXT NOT NULL DEFAULT 'task';
