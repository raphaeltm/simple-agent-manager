-- Per-project GitLab repository metadata.
--
-- GitLab uses user OAuth tokens rather than GitHub App installation tokens, so
-- project metadata is stored in a provider sidecar table while projects keeps
-- its historical non-null installation_id sentinel for non-GitHub providers.
CREATE TABLE IF NOT EXISTS project_gitlab_repositories (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  host TEXT NOT NULL,
  gitlab_project_id INTEGER NOT NULL,
  path_with_namespace TEXT NOT NULL,
  web_url TEXT,
  http_url_to_repo TEXT NOT NULL,
  default_branch TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_project_gitlab_repos_project
ON project_gitlab_repositories(project_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_project_gitlab_repos_user_host_project
ON project_gitlab_repositories(user_id, host, gitlab_project_id);

CREATE INDEX IF NOT EXISTS idx_project_gitlab_repos_project_user
ON project_gitlab_repositories(project_id, user_id);
