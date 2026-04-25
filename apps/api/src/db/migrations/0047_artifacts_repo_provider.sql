-- Add repo_provider column to projects (github or artifacts)
ALTER TABLE projects ADD COLUMN repo_provider TEXT NOT NULL DEFAULT 'github';

-- Add artifacts_repo_id for Artifacts-backed projects
ALTER TABLE projects ADD COLUMN artifacts_repo_id TEXT;

-- Make installation_id nullable for Artifacts-backed projects.
-- SQLite doesn't support ALTER COLUMN, so we recreate the table.
-- However, D1 migrations should be additive — and installation_id is already
-- referenced by existing FK constraints. Instead, we handle nullability at
-- the application layer: the Drizzle schema will mark it as nullable, and
-- Artifacts projects will insert NULL. The existing NOT NULL constraint in
-- the original CREATE TABLE will need to be handled by creating a new table.
--
-- Actually, SQLite's ALTER TABLE ADD COLUMN doesn't support NOT NULL without
-- a DEFAULT. And we can't ALTER COLUMN to remove NOT NULL in SQLite.
-- The pragmatic approach: create a new projects table, copy data, swap.

-- Step 1: Create new table without NOT NULL on installation_id
CREATE TABLE projects_new (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  description TEXT,
  installation_id TEXT REFERENCES github_installations(id) ON DELETE CASCADE,
  repository TEXT NOT NULL,
  default_branch TEXT NOT NULL DEFAULT 'main',
  github_repo_id INTEGER,
  github_repo_node_id TEXT,
  default_vm_size TEXT,
  default_agent_type TEXT,
  default_workspace_profile TEXT,
  default_devcontainer_config_name TEXT,
  default_provider TEXT,
  default_location TEXT,
  agent_defaults TEXT,
  workspace_idle_timeout_ms INTEGER,
  node_idle_timeout_ms INTEGER,
  task_execution_timeout_ms INTEGER,
  max_concurrent_tasks INTEGER,
  max_dispatch_depth INTEGER,
  max_sub_tasks_per_task INTEGER,
  warm_node_timeout_ms INTEGER,
  max_workspaces_per_node INTEGER,
  node_cpu_threshold_percent INTEGER,
  node_memory_threshold_percent INTEGER,
  status TEXT NOT NULL DEFAULT 'active',
  last_activity_at TEXT,
  active_session_count INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  repo_provider TEXT NOT NULL DEFAULT 'github',
  artifacts_repo_id TEXT
);

-- Step 2: Copy data from old table
INSERT INTO projects_new SELECT
  id, user_id, name, normalized_name, description, installation_id,
  repository, default_branch, github_repo_id, github_repo_node_id,
  default_vm_size, default_agent_type, default_workspace_profile,
  default_devcontainer_config_name, default_provider, default_location,
  agent_defaults, workspace_idle_timeout_ms, node_idle_timeout_ms,
  task_execution_timeout_ms, max_concurrent_tasks, max_dispatch_depth,
  max_sub_tasks_per_task, warm_node_timeout_ms, max_workspaces_per_node,
  node_cpu_threshold_percent, node_memory_threshold_percent,
  status, last_activity_at, active_session_count, created_by, created_at, updated_at,
  'github', NULL
FROM projects;

-- Step 3: Drop old table and rename
DROP TABLE projects;
ALTER TABLE projects_new RENAME TO projects;

-- Step 4: Recreate indexes
CREATE INDEX idx_projects_user_id ON projects(user_id);
CREATE INDEX idx_projects_installation_id ON projects(installation_id);
CREATE UNIQUE INDEX idx_projects_user_normalized_name ON projects(user_id, normalized_name);
CREATE UNIQUE INDEX idx_projects_user_installation_repository ON projects(user_id, installation_id, repository) WHERE user_id != 'system_anonymous_trials';
CREATE UNIQUE INDEX idx_projects_user_github_repo_id ON projects(user_id, github_repo_id) WHERE github_repo_id IS NOT NULL;
-- New: uniqueness for Artifacts projects
CREATE UNIQUE INDEX idx_projects_user_artifacts_repo ON projects(user_id, artifacts_repo_id) WHERE artifacts_repo_id IS NOT NULL;
