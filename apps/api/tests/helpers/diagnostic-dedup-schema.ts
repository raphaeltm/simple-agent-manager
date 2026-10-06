export const diagnosticDedupSchemaSql = `
ALTER TABLE diagnostic_incidents ADD COLUMN signature TEXT;
ALTER TABLE diagnostic_incidents ADD COLUMN deployment_id TEXT;
ALTER TABLE diagnostic_incidents ADD COLUMN occurrence_count INTEGER NOT NULL DEFAULT 1;
ALTER TABLE diagnostic_incidents ADD COLUMN last_seen_at TEXT;
UPDATE diagnostic_incidents SET last_seen_at = created_at WHERE last_seen_at IS NULL;
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
`;
