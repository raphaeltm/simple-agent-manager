-- D1 Session Summary Index
-- Read-optimized cross-project session index to eliminate DO fan-out.
-- The ProjectData DO remains authoritative; D1 is an eventually-consistent index.

CREATE TABLE session_summaries (
  id                  TEXT PRIMARY KEY,
  project_id          TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id             TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status              TEXT NOT NULL DEFAULT 'active',
  topic               TEXT,
  task_id             TEXT,
  workspace_id        TEXT,
  message_count       INTEGER NOT NULL DEFAULT 0,
  started_at          INTEGER NOT NULL,
  last_message_at     INTEGER,
  agent_completed_at  INTEGER,
  ended_at            INTEGER,
  updated_at          INTEGER NOT NULL
);

-- The money index: recent active sessions for a user, sorted by recency
CREATE INDEX idx_session_summaries_user_recent
  ON session_summaries(user_id, status, updated_at DESC);

-- For per-project listing (could replace some DO queries long-term)
CREATE INDEX idx_session_summaries_project
  ON session_summaries(project_id, updated_at DESC);
