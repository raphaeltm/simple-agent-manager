CREATE TABLE pull_requests (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  repository TEXT NOT NULL,
  number INTEGER NOT NULL,
  url TEXT NOT NULL,
  title TEXT,
  state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'closed', 'merged')),
  is_draft INTEGER NOT NULL DEFAULT 0,
  head_ref TEXT,
  head_sha TEXT,
  base_ref TEXT,
  author_login TEXT,
  merged_at TEXT,
  closed_at TEXT,
  checks_state TEXT CHECK (checks_state IN ('pending', 'success', 'failure', 'neutral')),
  checks_updated_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_synced_at TEXT
);
CREATE UNIQUE INDEX idx_pull_requests_project_repo_number ON pull_requests(project_id, repository, number);
CREATE INDEX idx_pull_requests_repository_head_sha ON pull_requests(repository, head_sha);
CREATE TABLE pull_request_refresh_budget (
  installation_id TEXT PRIMARY KEY NOT NULL,
  window_start INTEGER NOT NULL,
  used INTEGER NOT NULL DEFAULT 0,
  blocked_until INTEGER NOT NULL DEFAULT 0
);
ALTER TABLE tasks ADD COLUMN output_pr_number INTEGER;
ALTER TABLE tasks ADD COLUMN output_commit_sha TEXT;
