ALTER TABLE platform_feedback_triages ADD COLUMN queue_state TEXT NOT NULL DEFAULT 'resolved';
ALTER TABLE platform_feedback_triages ADD COLUMN queued_at INTEGER;
ALTER TABLE platform_feedback_triages ADD COLUMN dispatch_lease_token TEXT;
ALTER TABLE platform_feedback_triages ADD COLUMN dispatch_lease_expires_at INTEGER;
ALTER TABLE platform_feedback_triages ADD COLUMN dispatched_trigger_id TEXT REFERENCES triggers(id) ON DELETE SET NULL;
ALTER TABLE platform_feedback_triages ADD COLUMN dispatched_execution_id TEXT REFERENCES trigger_executions(id) ON DELETE SET NULL;
ALTER TABLE platform_feedback_triages ADD COLUMN dispatched_task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL;
ALTER TABLE platform_feedback_triages ADD COLUMN dispatched_at INTEGER;
ALTER TABLE platform_feedback_triages ADD COLUMN dispatch_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE platform_feedback_triages ADD COLUMN incident_claim_token TEXT;
ALTER TABLE platform_feedback_triages ADD COLUMN incident_claim_expires_at INTEGER;
ALTER TABLE platform_feedback_triages ADD COLUMN incident_claimed_by_task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL;
ALTER TABLE platform_feedback_triages ADD COLUMN incident_claimed_at INTEGER;
ALTER TABLE platform_feedback_triages ADD COLUMN resolved_at INTEGER;
ALTER TABLE platform_feedback_triages ADD COLUMN resolved_by_task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL;
ALTER TABLE platform_feedback_triages ADD COLUMN resolution_note TEXT;
ALTER TABLE platform_feedback_triages ADD COLUMN expired_at INTEGER;

CREATE INDEX IF NOT EXISTS idx_platform_feedback_triages_queue_state
  ON platform_feedback_triages(queue_state, queued_at, last_seen_at);
CREATE INDEX IF NOT EXISTS idx_platform_feedback_triages_dispatch_lease
  ON platform_feedback_triages(dispatch_lease_expires_at)
  WHERE dispatch_lease_expires_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_platform_feedback_triages_incident_claim
  ON platform_feedback_triages(incident_claim_expires_at)
  WHERE incident_claim_expires_at IS NOT NULL;
