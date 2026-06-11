-- Deployment environments and releases for app-deployment slice 2.
-- Environments belong to a project; releases are immutable manifest snapshots.

CREATE TABLE deployment_environments (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX idx_deployment_environments_project_name
  ON deployment_environments(project_id, name);

CREATE INDEX idx_deployment_environments_project_id
  ON deployment_environments(project_id);

CREATE TABLE deployment_releases (
  id TEXT PRIMARY KEY,
  environment_id TEXT NOT NULL REFERENCES deployment_environments(id) ON DELETE CASCADE,
  manifest TEXT NOT NULL,
  version INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'created',
  created_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_deployment_releases_environment_id
  ON deployment_releases(environment_id);

CREATE UNIQUE INDEX idx_deployment_releases_env_version
  ON deployment_releases(environment_id, version);
