-- Additive: preserve executions and all child records.
ALTER TABLE github_trigger_configs ADD COLUMN subject_affinity INTEGER NOT NULL DEFAULT 0;
ALTER TABLE github_trigger_configs ADD COLUMN queue_max_pending INTEGER NOT NULL DEFAULT 50;
ALTER TABLE github_trigger_configs ADD COLUMN queue_ttl_seconds INTEGER NOT NULL DEFAULT 86400;
ALTER TABLE trigger_executions ADD COLUMN subject_key TEXT;
ALTER TABLE trigger_executions ADD COLUMN queue_expires_at TEXT;
ALTER TABLE trigger_executions ADD COLUMN queue_attempted_at TEXT;
ALTER TABLE trigger_executions ADD COLUMN routed_execution_id TEXT;
ALTER TABLE trigger_executions ADD COLUMN routed_task_id TEXT;
ALTER TABLE trigger_executions ADD COLUMN routed_session_id TEXT;
CREATE INDEX idx_trigger_queue_pending ON trigger_executions(status, created_at)
  WHERE queue_expires_at IS NOT NULL AND status IN ('waiting', 'routing', 'queued');
CREATE INDEX idx_trigger_subject ON trigger_executions(trigger_id, subject_key, status)
  WHERE subject_key IS NOT NULL;
