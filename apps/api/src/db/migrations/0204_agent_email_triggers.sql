-- Agent email (prototype): email triggers, their message metadata, and 'email' task provenance.

-- One row per email trigger. The address is agent+<address_key>@mail.<BASE_DOMAIN>.
CREATE TABLE trigger_email_configs (
  trigger_id TEXT PRIMARY KEY REFERENCES triggers(id) ON DELETE CASCADE,
  address_key TEXT NOT NULL UNIQUE CHECK (length(address_key) BETWEEN 8 AND 64),
  allowed_senders_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Metadata only: message bodies are never stored here. Inbound rows dedupe retried
-- deliveries on (trigger_id, message_id); outbound rows count replies against the
-- per-run cap and record the provider result.
CREATE TABLE trigger_email_messages (
  id TEXT PRIMARY KEY,
  trigger_id TEXT NOT NULL REFERENCES triggers(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  trigger_execution_id TEXT,
  direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  status TEXT NOT NULL CHECK (
    status IN ('processing', 'accepted', 'rejected', 'failed', 'sending', 'sent')
  ),
  reason TEXT,
  message_id TEXT,
  references_header TEXT,
  from_address TEXT NOT NULL,
  to_address TEXT NOT NULL,
  subject TEXT NOT NULL DEFAULT '',
  raw_size INTEGER,
  provider_message_id TEXT,
  lease_expires_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX idx_trigger_email_messages_inbound
  ON trigger_email_messages(trigger_id, message_id) WHERE direction = 'inbound';
CREATE INDEX idx_trigger_email_messages_execution
  ON trigger_email_messages(trigger_execution_id, direction);

-- Widen task_submission_checkpoints.triggered_by to accept 'email', using the 0202
-- pattern: copy every column into a new table, keep the old one as a migration archive,
-- and recreate every current index. No table references this leaf; no table or row is
-- dropped. The archive is historical, not a rollback source.
CREATE TABLE task_submission_checkpoints_email (
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
    triggered_by IN ('user', 'cron', 'webhook', 'github', 'incident', 'mcp', 'email')
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

INSERT INTO task_submission_checkpoints_email SELECT * FROM task_submission_checkpoints;
ALTER TABLE task_submission_checkpoints RENAME TO task_submission_checkpoints_pre_email;
DROP INDEX idx_task_submission_checkpoints_chat_session;
DROP INDEX idx_task_submission_checkpoints_initial_message;
DROP INDEX idx_task_submission_checkpoints_initial_status_event;
DROP INDEX idx_task_submission_checkpoints_source;
DROP INDEX idx_task_submission_checkpoints_state;
ALTER TABLE task_submission_checkpoints_email RENAME TO task_submission_checkpoints;
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
