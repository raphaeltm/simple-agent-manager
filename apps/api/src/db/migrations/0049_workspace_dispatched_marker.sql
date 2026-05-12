-- Add dispatch marker to prevent duplicate workspace creation requests.
-- When TaskRunner dispatches a workspace to the VM agent, it sets this timestamp.
-- The node-ready safety-net handler skips workspaces that already have this marker.
ALTER TABLE workspaces ADD COLUMN dispatched_to_agent_at TEXT;
