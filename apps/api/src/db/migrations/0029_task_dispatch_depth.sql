-- Add dispatch_depth column for agent-to-agent task spawning.
-- 0 = user-created task, N = Nth generation agent dispatch.
ALTER TABLE tasks ADD COLUMN dispatch_depth INTEGER NOT NULL DEFAULT 0;
