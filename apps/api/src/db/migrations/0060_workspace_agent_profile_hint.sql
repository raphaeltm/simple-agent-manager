-- Add agent_profile_hint to workspaces for policy enforcement.
-- The tasks table FK constraint prevents task insertion for DO-only projects,
-- so we store the profile hint directly on the workspace.
ALTER TABLE workspaces ADD COLUMN agent_profile_hint TEXT;
