-- Positive server-written provenance survives release/replacement of a task's current node.
-- Existing rows keep their indexed task-link/snapshot proofs; no legacy authority is removed.
ALTER TABLE nodes ADD COLUMN task_provisioned INTEGER NOT NULL DEFAULT 0 CHECK (task_provisioned IN (0, 1));
