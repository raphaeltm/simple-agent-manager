ALTER TABLE diagnostic_incidents ADD COLUMN signature TEXT;
ALTER TABLE diagnostic_incidents ADD COLUMN deployment_id TEXT;
ALTER TABLE diagnostic_incidents ADD COLUMN occurrence_count INTEGER NOT NULL DEFAULT 1;
ALTER TABLE diagnostic_incidents ADD COLUMN last_seen_at TEXT;

UPDATE diagnostic_incidents
SET last_seen_at = created_at
WHERE last_seen_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_diagnostic_incidents_signature_deployment
  ON diagnostic_incidents(signature, deployment_id)
  WHERE signature IS NOT NULL AND deployment_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS diagnostic_incident_occurrences (
  platform_error_id TEXT PRIMARY KEY NOT NULL,
  incident_id TEXT NOT NULL REFERENCES diagnostic_incidents(id) ON DELETE CASCADE,
  node_id TEXT NOT NULL,
  workspace_id TEXT,
  occurred_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_diagnostic_incident_occurrences_incident
  ON diagnostic_incident_occurrences(incident_id, occurred_at);

ALTER TABLE platform_feedback_triages ADD COLUMN severity TEXT NOT NULL DEFAULT 'error';
ALTER TABLE platform_feedback_triages ADD COLUMN budget_deferred_until INTEGER;
ALTER TABLE platform_feedback_triages ADD COLUMN budget_deferred_reason TEXT;
ALTER TABLE platform_feedback_triages ADD COLUMN budget_defer_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE platform_feedback_triages ADD COLUMN last_budget_deferred_at INTEGER;

CREATE INDEX IF NOT EXISTS idx_platform_feedback_triages_budget_defer
  ON platform_feedback_triages(budget_deferred_until)
  WHERE budget_deferred_until IS NOT NULL;

UPDATE platform_feedback_triages
SET
  queue_state = 'pending',
  queued_at = COALESCE(queued_at, last_seen_at),
  rejected_at = NULL,
  failure_count = 0,
  budget_deferred_until = NULL,
  budget_deferred_reason = last_failure_reason,
  budget_defer_count = CASE WHEN budget_defer_count = 0 THEN 1 ELSE budget_defer_count END,
  last_budget_deferred_at = COALESCE(last_failed_at, last_seen_at),
  updated_at = CURRENT_TIMESTAMP
WHERE rejected_at IS NOT NULL
  AND (
    last_failure_reason = 'Daily deployment debugging budget exhausted'
    OR last_failure_reason = 'Per-run debugging token ceiling reached'
  );
