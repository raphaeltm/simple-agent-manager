-- Add extended configuration columns to agent_profiles for task runner integration.
-- These allow profiles to specify infrastructure preferences alongside agent settings.
-- All nullable: null = inherit from project/platform defaults.

ALTER TABLE agent_profiles ADD COLUMN provider TEXT;
ALTER TABLE agent_profiles ADD COLUMN vm_location TEXT;
ALTER TABLE agent_profiles ADD COLUMN workspace_profile TEXT;
ALTER TABLE agent_profiles ADD COLUMN task_mode TEXT;
