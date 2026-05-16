CREATE TABLE IF NOT EXISTS profile_runtime_env_vars (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES agent_profiles(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  env_key TEXT NOT NULL,
  stored_value TEXT NOT NULL,
  value_iv TEXT,
  is_secret INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_profile_runtime_env_profile_key
ON profile_runtime_env_vars(profile_id, env_key);
CREATE INDEX IF NOT EXISTS idx_profile_runtime_env_user_profile
ON profile_runtime_env_vars(user_id, profile_id);

CREATE TABLE IF NOT EXISTS profile_runtime_files (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES agent_profiles(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  file_path TEXT NOT NULL,
  stored_content TEXT NOT NULL,
  content_iv TEXT,
  is_secret INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_profile_runtime_files_profile_path
ON profile_runtime_files(profile_id, file_path);
CREATE INDEX IF NOT EXISTS idx_profile_runtime_files_user_profile
ON profile_runtime_files(user_id, profile_id);
