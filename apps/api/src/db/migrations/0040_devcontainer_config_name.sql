-- Add devcontainer config name columns for multiple devcontainer configuration support.
-- Nullable: null = auto-discover default config (current behavior).
-- When set, the VM agent passes --config .devcontainer/<name>/devcontainer.json to the devcontainer CLI.

ALTER TABLE projects ADD COLUMN default_devcontainer_config_name TEXT;

ALTER TABLE workspaces ADD COLUMN devcontainer_config_name TEXT;

ALTER TABLE agent_profiles ADD COLUMN devcontainer_config_name TEXT;
