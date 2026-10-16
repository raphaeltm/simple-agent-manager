-- Preserve historical executions while resetting the failure window on resume.
ALTER TABLE triggers ADD COLUMN auto_pause_reset_sequence INTEGER;
