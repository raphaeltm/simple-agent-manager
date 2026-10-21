-- Per-person "hide from new chat" choices for the new-chat profile picker.
-- Hiding only tidies one person's picker in one project; the profile itself, its
-- automations, dispatch and @mentions are unaffected. A row exists only while hidden.
CREATE TABLE IF NOT EXISTS agent_profile_picker_hidden (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  profile_id TEXT NOT NULL REFERENCES agent_profiles(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, project_id, profile_id)
);

CREATE INDEX IF NOT EXISTS idx_agent_profile_picker_hidden_profile
ON agent_profile_picker_hidden(profile_id);
