-- Additional same-installation GitHub repositories a project's workspace tokens
-- may access (Codespaces-style "additional repository access"). The primary
-- project repository is always included implicitly and is NOT stored here.
-- Workspace /git-token mints scope repository_ids to the primary repo plus all
-- active rows here, so same-org submodules can be fetched.
--
-- NOTE: This is a brand-new additive table (CREATE TABLE only, no DROP). D1 does
-- NOT enforce these FK constraints on delete, so application code must delete
-- child rows explicitly when a project is removed (see projects delete batch).
CREATE TABLE IF NOT EXISTS project_github_repositories (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  repository TEXT NOT NULL,
  github_repo_id INTEGER NOT NULL,
  github_repo_node_id TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_project_github_repos_project_repo
ON project_github_repositories(project_id, repository);

CREATE INDEX IF NOT EXISTS idx_project_github_repos_user_project
ON project_github_repositories(user_id, project_id);
