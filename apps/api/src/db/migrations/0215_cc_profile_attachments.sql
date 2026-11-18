-- Personal profile pins: "when I run this agent profile, use this account of mine".
--
-- A separate table, not a column on cc_attachments: ~20 readers of cc_attachments
-- treat `project_id IS NULL` as the user's default, so a profile row there would be
-- read as a default (rule 63). Each row belongs to one user and applies only to that
-- user's runs. Cascades: deleting the configuration, the user or the profile removes
-- the pin.
CREATE TABLE cc_profile_attachments (
  id TEXT PRIMARY KEY,
  configuration_id TEXT NOT NULL REFERENCES cc_configurations(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  agent_profile_id TEXT NOT NULL REFERENCES agent_profiles(id) ON DELETE CASCADE,
  consumer_kind TEXT NOT NULL,
  consumer_target TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX idx_cc_profile_attachments_user_profile_consumer
  ON cc_profile_attachments(user_id, agent_profile_id, consumer_kind, consumer_target);
CREATE INDEX idx_cc_profile_attachments_profile ON cc_profile_attachments(agent_profile_id);
CREATE INDEX idx_cc_profile_attachments_config ON cc_profile_attachments(configuration_id);

-- Which resolution tier chose the agent credential ('profile' | 'project' | 'user' |
-- 'platform'). agent_credential_source keeps meaning who owns the credential and its
-- CHECK constraint cannot be widened without rebuilding agent_sessions.
ALTER TABLE agent_sessions ADD COLUMN agent_credential_scope TEXT;
