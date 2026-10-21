-- Workflow runs extend missions. No existing mission is converted.
ALTER TABLE missions ADD COLUMN workflow_plan_json TEXT;
ALTER TABLE missions ADD COLUMN workflow_request_key TEXT;
ALTER TABLE missions ADD COLUMN workflow_plan_fingerprint TEXT;
ALTER TABLE missions ADD COLUMN workflow_deadline_at INTEGER;
CREATE UNIQUE INDEX idx_missions_workflow_request ON missions(project_id, user_id, workflow_request_key)
 WHERE workflow_request_key IS NOT NULL;

CREATE TABLE mission_steps (
 mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
 step_key TEXT NOT NULL,
 ordinal INTEGER NOT NULL,
 title TEXT NOT NULL,
 instructions TEXT NOT NULL,
 after_json TEXT NOT NULL,
 profile_id TEXT NOT NULL,
 profile_snapshot_json TEXT NOT NULL,
 state TEXT NOT NULL DEFAULT 'waiting' CHECK(state IN ('waiting','starting','running','completed','failed','blocked')),
 attempt_id TEXT NOT NULL UNIQUE,
 task_id TEXT NOT NULL UNIQUE,
 session_id TEXT NOT NULL UNIQUE,
 submission_json TEXT,
 launch_retries INTEGER NOT NULL DEFAULT 0,
 next_attempt_at INTEGER NOT NULL DEFAULT 0,
 result_json TEXT,
 reason TEXT,
 updated_at TEXT NOT NULL,
 PRIMARY KEY (mission_id, step_key)
);
CREATE INDEX idx_mission_steps_task ON mission_steps(task_id);

-- Preserve the old checkpoint table as a migration archive while widening its
-- source_kind CHECK. No table references this leaf. Copy every column and
-- recreate every current index; no persisted table or row is dropped.
-- The archive is historical, not a rollback source: new writes use only the
-- canonical table, and parent deletions still cascade into archived rows.
CREATE TABLE task_submission_checkpoints_workflow (
  task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  chat_session_id TEXT NOT NULL,
  initial_message_id TEXT NOT NULL,
  initial_status_event_id TEXT NOT NULL REFERENCES task_status_events(id) ON DELETE CASCADE,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('trigger', 'schedule', 'standing_watch', 'workflow')),
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


INSERT INTO task_submission_checkpoints_workflow SELECT * FROM task_submission_checkpoints;
ALTER TABLE task_submission_checkpoints RENAME TO task_submission_checkpoints_pre_workflow;
DROP INDEX idx_task_submission_checkpoints_chat_session;
DROP INDEX idx_task_submission_checkpoints_initial_message;
DROP INDEX idx_task_submission_checkpoints_initial_status_event;
DROP INDEX idx_task_submission_checkpoints_source;
DROP INDEX idx_task_submission_checkpoints_state;
ALTER TABLE task_submission_checkpoints_workflow RENAME TO task_submission_checkpoints;
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

CREATE TABLE mission_workflow_events (
 id TEXT PRIMARY KEY,
 mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
 event_type TEXT NOT NULL,
 event_payload_json TEXT NOT NULL,
 created_at TEXT NOT NULL
);
CREATE INDEX idx_mission_workflow_events_run ON mission_workflow_events(mission_id,created_at,id);
