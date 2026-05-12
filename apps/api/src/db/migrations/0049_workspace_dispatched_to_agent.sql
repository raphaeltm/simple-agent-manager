-- Add dispatched_to_agent_at column to prevent duplicate workspace creation
-- when both the TaskRunner DO and the node-ready handler race to dispatch
-- the same workspace to the VM agent.
ALTER TABLE workspaces ADD COLUMN dispatched_to_agent_at TEXT;
