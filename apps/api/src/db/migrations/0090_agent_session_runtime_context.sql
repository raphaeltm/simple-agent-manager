-- Persist runtime asset context for taskless agent sessions.
ALTER TABLE agent_sessions ADD COLUMN agent_profile_id TEXT REFERENCES agent_profiles(id) ON DELETE SET NULL;
ALTER TABLE agent_sessions ADD COLUMN skill_id TEXT REFERENCES skills(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_agent_sessions_agent_profile_id ON agent_sessions(agent_profile_id);
CREATE INDEX IF NOT EXISTS idx_agent_sessions_skill_id ON agent_sessions(skill_id);
