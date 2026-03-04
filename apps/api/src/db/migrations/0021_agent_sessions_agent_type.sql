-- Persist the selected agent type (e.g., 'claude-code', 'openai-codex') with
-- each agent session so the frontend can restore the correct agent after a page
-- refresh instead of falling back to the first configured agent.
ALTER TABLE agent_sessions ADD COLUMN agent_type TEXT;
