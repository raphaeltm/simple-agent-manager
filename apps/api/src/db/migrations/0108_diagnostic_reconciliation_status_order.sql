-- Bound pending/available reconciliation scans without sorting retained rows.
CREATE INDEX IF NOT EXISTS idx_diagnostic_artifacts_status_updated
  ON diagnostic_artifacts(status, datetime(updated_at), id);
