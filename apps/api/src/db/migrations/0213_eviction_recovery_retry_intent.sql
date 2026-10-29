-- Preserve pre-stop continuation evidence across a failed replacement startup.
-- NULL is intentional for legacy snapshots: existing runtime-lost reconciliation applies.
ALTER TABLE session_snapshots ADD COLUMN eviction_recovery_interrupted_work INTEGER
  CHECK (eviction_recovery_interrupted_work IS NULL OR eviction_recovery_interrupted_work IN (0, 1));

-- Cron normally has zero candidates; avoid a full snapshot scan to find failed evictions.
CREATE INDEX idx_session_snapshots_failed_eviction_retry
  ON session_snapshots(updated_at)
  WHERE recovery_status = 'failed' AND eviction_recovery_workspace_id IS NOT NULL;
