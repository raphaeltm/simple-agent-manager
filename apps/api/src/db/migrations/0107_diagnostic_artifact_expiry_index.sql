-- Keep the five-minute diagnostic artifact expiry sweep proportional to work
-- remaining instead of retained expired metadata.
CREATE INDEX IF NOT EXISTS idx_diagnostic_artifacts_pending_expiry
  ON diagnostic_artifacts(expires_at)
  WHERE status <> 'expired';
