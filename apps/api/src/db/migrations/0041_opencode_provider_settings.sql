-- Add OpenCode provider settings columns to agent_settings table.
-- All nullable: null means "use default" provider.
ALTER TABLE agent_settings ADD COLUMN opencode_provider TEXT;
ALTER TABLE agent_settings ADD COLUMN opencode_base_url TEXT;
ALTER TABLE agent_settings ADD COLUMN opencode_provider_name TEXT;
