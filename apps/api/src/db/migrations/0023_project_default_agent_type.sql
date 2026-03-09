-- Add default_agent_type column to projects table
-- Allows per-project agent type selection (e.g., 'claude-code', 'openai-codex', 'google-gemini')
-- Nullable: when NULL, falls back to platform default
ALTER TABLE projects ADD COLUMN default_agent_type TEXT;
