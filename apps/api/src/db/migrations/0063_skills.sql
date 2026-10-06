CREATE TABLE IF NOT EXISTS skills (
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
  provider TEXT,
  vm_location TEXT,
  workspace_profile TEXT,
  devcontainer_config_name TEXT,
  task_mode TEXT DEFAULT 'task',
  resource_requirements_json TEXT,
  default_profile_id TEXT REFERENCES agent_profiles(id) ON DELETE SET NULL,
  is_builtin INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_skills_project_name
ON skills(project_id, name)
WHERE project_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_skills_global_name
ON skills(user_id, name)
WHERE project_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_skills_project_id
ON skills(project_id);

CREATE INDEX IF NOT EXISTS idx_skills_user_id
ON skills(user_id);

CREATE INDEX IF NOT EXISTS idx_skills_default_profile_id
ON skills(default_profile_id);

CREATE TABLE IF NOT EXISTS skill_runtime_env_vars (
  id TEXT PRIMARY KEY,
  skill_id TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  env_key TEXT NOT NULL,
  stored_value TEXT NOT NULL,
  value_iv TEXT,
  is_secret INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_skill_runtime_env_skill_key
ON skill_runtime_env_vars(skill_id, env_key);

CREATE INDEX IF NOT EXISTS idx_skill_runtime_env_user_skill
ON skill_runtime_env_vars(user_id, skill_id);

CREATE TABLE IF NOT EXISTS skill_runtime_files (
  id TEXT PRIMARY KEY,
  skill_id TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  file_path TEXT NOT NULL,
  stored_content TEXT NOT NULL,
  content_iv TEXT,
  is_secret INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_skill_runtime_files_skill_path
ON skill_runtime_files(skill_id, file_path);

CREATE INDEX IF NOT EXISTS idx_skill_runtime_files_user_skill
ON skill_runtime_files(user_id, skill_id);

ALTER TABLE tasks ADD COLUMN skill_id TEXT REFERENCES skills(id) ON DELETE SET NULL;
ALTER TABLE tasks ADD COLUMN skill_hint TEXT;
ALTER TABLE triggers ADD COLUMN skill_id TEXT REFERENCES skills(id) ON DELETE SET NULL;
