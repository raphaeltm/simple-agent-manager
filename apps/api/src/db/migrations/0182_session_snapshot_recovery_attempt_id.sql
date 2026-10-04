-- A task survives multiple VM wakes; each claim needs its own authority fence.
-- Legacy claims remain NULL and continue through their existing runner path.
ALTER TABLE session_snapshots ADD COLUMN recovery_attempt_id TEXT;
