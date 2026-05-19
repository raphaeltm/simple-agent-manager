-- Add provider_mode column to agent_settings.
-- Stores the explicit AI provider selection for Claude Code / Codex:
-- 'sam' = platform-managed proxy, 'user-api-key' = user-owned key, 'oauth' = direct OAuth.
-- NULL = no explicit selection (backward-compatible default).
ALTER TABLE agent_settings ADD COLUMN provider_mode TEXT;
