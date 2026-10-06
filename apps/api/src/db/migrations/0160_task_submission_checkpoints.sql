-- Retry-safe reserved-identity task submission checkpoints.
--
-- This table records the immutable task/session/message/status identities and
-- accepted non-secret start snapshot for one normal task submission. Callers
-- must reserve their source intent durably before invoking the adapter; this
-- table is the D1-side boundary created atomically with the task row and initial
-- queued status event.

CREATE TABLE task_submission_checkpoints (
  task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  chat_session_id TEXT NOT NULL,
  initial_message_id TEXT NOT NULL,
  initial_status_event_id TEXT NOT NULL REFERENCES task_status_events(id) ON DELETE CASCADE,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('trigger', 'schedule', 'standing_watch')),
  source_id TEXT NOT NULL CHECK (length(source_id) BETWEEN 1 AND 160),
  source_execution_id TEXT NOT NULL CHECK (length(source_execution_id) BETWEEN 1 AND 160),
  triggered_by TEXT NOT NULL CHECK (
    triggered_by IN ('user', 'cron', 'webhook', 'github', 'incident', 'mcp')
  ),
  intent_fingerprint TEXT NOT NULL CHECK (length(intent_fingerprint) = 71),
  accepted_snapshot_json TEXT NOT NULL,
  branch_name TEXT NOT NULL,
  task_title TEXT NOT NULL,
  checkpoint_state TEXT NOT NULL DEFAULT 'd1_committed' CHECK (
    checkpoint_state IN (
      'd1_committed',
      'project_data_committed',
      'start_pending',
      'start_confirmed'
    )
  ),
  project_data_committed_at TEXT,
  runner_start_attempted_at TEXT,
  runner_started_at TEXT,
  terminal_observed_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX idx_task_submission_checkpoints_chat_session
  ON task_submission_checkpoints(chat_session_id);

CREATE UNIQUE INDEX idx_task_submission_checkpoints_initial_message
  ON task_submission_checkpoints(initial_message_id);

CREATE UNIQUE INDEX idx_task_submission_checkpoints_initial_status_event
  ON task_submission_checkpoints(initial_status_event_id);

CREATE UNIQUE INDEX idx_task_submission_checkpoints_source
  ON task_submission_checkpoints(project_id, source_kind, source_id, source_execution_id);

CREATE INDEX idx_task_submission_checkpoints_state
  ON task_submission_checkpoints(checkpoint_state, updated_at);
