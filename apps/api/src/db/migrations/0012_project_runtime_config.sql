ALTER TABLE workspaces ADD COLUMN project_id TEXT REFERENCES projects(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_workspaces_project_id ON workspaces(project_id);
CREATE INDEX IF NOT EXISTS idx_workspaces_user_project_status ON workspaces(user_id, project_id, status);

CREATE TABLE IF NOT EXISTS project_runtime_env_vars (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  env_key TEXT NOT NULL,
  stored_value TEXT NOT NULL,
  value_iv TEXT,
  is_secret INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_project_runtime_env_project_key
ON project_runtime_env_vars(project_id, env_key);
CREATE INDEX IF NOT EXISTS idx_project_runtime_env_user_project
ON project_runtime_env_vars(user_id, project_id);

CREATE TABLE IF NOT EXISTS project_runtime_files (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  file_path TEXT NOT NULL,
  stored_content TEXT NOT NULL,
  content_iv TEXT,
  is_secret INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_project_runtime_files_project_path
ON project_runtime_files(project_id, file_path);
CREATE INDEX IF NOT EXISTS idx_project_runtime_files_user_project
ON project_runtime_files(user_id, project_id);
