-- Reserved task-backed chat sessions need a D1-visible lifecycle fence before
-- ProjectData terminalization can race TaskRunner physical allocation.

CREATE TABLE reserved_task_session_revocations (
  project_id      TEXT NOT NULL,
  chat_session_id TEXT NOT NULL,
  task_id         TEXT NOT NULL,
  reason          TEXT NOT NULL,
  source          TEXT NOT NULL,
  revoked_at      TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (project_id, chat_session_id)
);

CREATE INDEX idx_reserved_task_session_revocations_task
  ON reserved_task_session_revocations(task_id);
