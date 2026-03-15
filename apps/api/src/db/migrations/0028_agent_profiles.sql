-- Agent Profiles: per-project role definitions for agent configurations
-- Unlike agent_settings (per-user, per-agent-type preferences), agent_profiles
-- define reusable "roles" (planner, implementer, reviewer) scoped to a project.

CREATE TABLE agent_profiles (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  agent_type TEXT NOT NULL DEFAULT 'claude-code',
  model TEXT,
  permission_mode TEXT,
  system_prompt_append TEXT,
  max_turns INTEGER,
  timeout_minutes INTEGER,
  vm_size_override TEXT,
  is_builtin INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Unique constraint: no two profiles with the same name in the same project.
-- For global profiles (project_id IS NULL), uniqueness is per-user.
-- SQLite treats NULLs as distinct in UNIQUE constraints, so we need two indexes:
-- 1. For project-scoped profiles (project_id IS NOT NULL)
CREATE UNIQUE INDEX idx_agent_profiles_project_name
  ON agent_profiles(project_id, name)
  WHERE project_id IS NOT NULL;

-- 2. For global profiles (project_id IS NULL), unique per user
CREATE UNIQUE INDEX idx_agent_profiles_global_name
  ON agent_profiles(user_id, name)
  WHERE project_id IS NULL;

-- Lookup indexes
CREATE INDEX idx_agent_profiles_project_id ON agent_profiles(project_id);
CREATE INDEX idx_agent_profiles_user_id ON agent_profiles(user_id);
