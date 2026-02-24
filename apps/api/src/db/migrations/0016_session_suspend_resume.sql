-- Add suspend/resume support to agent_sessions table.
-- suspended_at tracks when a session was suspended; last_prompt captures
-- the last user message for session discoverability in the history UI.
ALTER TABLE agent_sessions ADD COLUMN suspended_at TEXT;
ALTER TABLE agent_sessions ADD COLUMN last_prompt TEXT;
