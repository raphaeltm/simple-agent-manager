-- Preserve the active-only index for its existing callers. The stuck-task sweep
-- also consumes owner-approved sleeping recovery intents in the same keyset order.
CREATE INDEX IF NOT EXISTS idx_tasks_recovery_scan_updated_id
  ON tasks(updated_at, id)
  WHERE status IN ('queued', 'delegated', 'in_progress')
    OR (status='sleeping' AND admission_state='provider_limit_recovery_pending');
