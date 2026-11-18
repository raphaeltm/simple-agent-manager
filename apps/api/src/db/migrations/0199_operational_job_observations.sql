-- Bounded metadata from authenticated exec_with_secrets responses. No command,
-- output, environment, secret names or credential identity is persisted here.
CREATE TABLE operational_job_observations (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  chat_session_id TEXT NOT NULL,
  owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  job_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  agent_session_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('running','completed','failed','cancelled','timed_out','interrupted')),
  exit_code INTEGER,
  observed_at INTEGER NOT NULL,
  PRIMARY KEY(project_id, chat_session_id, owner_user_id, job_id)
);
CREATE INDEX idx_operational_jobs_session ON operational_job_observations(project_id, chat_session_id, owner_user_id, observed_at DESC, job_id);
