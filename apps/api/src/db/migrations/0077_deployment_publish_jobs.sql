CREATE TABLE deployment_publish_jobs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  environment_id TEXT NOT NULL REFERENCES deployment_environments(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL,
  node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  task_id TEXT,
  agent_profile_id TEXT,
  requested_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  environment_name TEXT NOT NULL,
  reference TEXT NOT NULL DEFAULT 'latest',
  working_dir TEXT,
  source_dir TEXT,
  status TEXT NOT NULL DEFAULT 'queued',
  current_step TEXT,
  release_id TEXT REFERENCES deployment_releases(id) ON DELETE SET NULL,
  release_version INTEGER,
  release_status TEXT,
  error_message TEXT,
  error_code TEXT,
  retryable INTEGER NOT NULL DEFAULT 0,
  attempt INTEGER NOT NULL DEFAULT 1,
  last_event_at TEXT,
  started_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_deployment_publish_jobs_project_created_at
  ON deployment_publish_jobs(project_id, created_at DESC);
CREATE INDEX idx_deployment_publish_jobs_environment_created_at
  ON deployment_publish_jobs(environment_id, created_at DESC);
CREATE INDEX idx_deployment_publish_jobs_workspace_created_at
  ON deployment_publish_jobs(workspace_id, created_at DESC);
CREATE INDEX idx_deployment_publish_jobs_status_updated_at
  ON deployment_publish_jobs(status, updated_at);
CREATE INDEX idx_deployment_publish_jobs_release_id
  ON deployment_publish_jobs(release_id);

CREATE TABLE deployment_publish_job_events (
  id TEXT PRIMARY KEY,
  publish_job_id TEXT NOT NULL REFERENCES deployment_publish_jobs(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  environment_id TEXT NOT NULL REFERENCES deployment_environments(id) ON DELETE CASCADE,
  node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  level TEXT NOT NULL DEFAULT 'info',
  event_type TEXT NOT NULL,
  step TEXT,
  message TEXT NOT NULL,
  detail_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX idx_deployment_publish_job_events_job_seq
  ON deployment_publish_job_events(publish_job_id, seq);
CREATE INDEX idx_deployment_publish_job_events_project_created_at
  ON deployment_publish_job_events(project_id, created_at DESC);
CREATE INDEX idx_deployment_publish_job_events_environment_created_at
  ON deployment_publish_job_events(environment_id, created_at DESC);

CREATE TABLE deployment_release_events (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  environment_id TEXT NOT NULL REFERENCES deployment_environments(id) ON DELETE CASCADE,
  release_id TEXT REFERENCES deployment_releases(id) ON DELETE CASCADE,
  release_version INTEGER,
  node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  level TEXT NOT NULL DEFAULT 'info',
  event_type TEXT NOT NULL,
  step TEXT,
  message TEXT NOT NULL,
  detail_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_deployment_release_events_release_seq
  ON deployment_release_events(release_id, seq);
CREATE INDEX idx_deployment_release_events_environment_created_at
  ON deployment_release_events(environment_id, created_at DESC);
CREATE INDEX idx_deployment_release_events_node_created_at
  ON deployment_release_events(node_id, created_at DESC);
