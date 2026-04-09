-- Event-Driven Triggers: cron schedules (Phase 0), extensible to webhooks/GitHub events
-- Triggers define event sources that dispatch tasks through the existing TaskRunner pipeline.

CREATE TABLE triggers (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  source_type TEXT NOT NULL,
  cron_expression TEXT,
  cron_timezone TEXT DEFAULT 'UTC',
  skip_if_running INTEGER DEFAULT 1,
  prompt_template TEXT NOT NULL,
  agent_profile_id TEXT REFERENCES agent_profiles(id) ON DELETE SET NULL,
  task_mode TEXT DEFAULT 'task',
  vm_size_override TEXT,
  max_concurrent INTEGER DEFAULT 1,
  last_triggered_at TEXT,
  trigger_count INTEGER DEFAULT 0,
  next_fire_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Unique trigger name per project
CREATE UNIQUE INDEX idx_triggers_project_name ON triggers(project_id, name);

-- Cron sweep index: quickly find active cron triggers due to fire
CREATE INDEX idx_triggers_cron_sweep
  ON triggers(source_type, status, next_fire_at)
  WHERE source_type = 'cron' AND status = 'active';

-- Lookup by user
CREATE INDEX idx_triggers_user_id ON triggers(user_id);

-- Lookup by project
CREATE INDEX idx_triggers_project_id ON triggers(project_id);

-- Trigger Executions: audit log of every trigger firing attempt
CREATE TABLE trigger_executions (
  id TEXT PRIMARY KEY,
  trigger_id TEXT NOT NULL REFERENCES triggers(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL,
  status TEXT NOT NULL,
  skip_reason TEXT,
  task_id TEXT,
  event_type TEXT,
  rendered_prompt TEXT,
  error_message TEXT,
  scheduled_at TEXT,
  started_at TEXT,
  completed_at TEXT,
  sequence_number INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Find active executions for a trigger (skip-if-running check)
CREATE INDEX idx_trigger_executions_active
  ON trigger_executions(trigger_id, status)
  WHERE status IN ('queued', 'running');

-- Lookup by trigger
CREATE INDEX idx_trigger_executions_trigger_id ON trigger_executions(trigger_id);

-- Tasks table additions: track trigger provenance
ALTER TABLE tasks ADD COLUMN triggered_by TEXT DEFAULT 'user';
ALTER TABLE tasks ADD COLUMN trigger_id TEXT REFERENCES triggers(id) ON DELETE SET NULL;
ALTER TABLE tasks ADD COLUMN trigger_execution_id TEXT REFERENCES trigger_executions(id) ON DELETE SET NULL;
