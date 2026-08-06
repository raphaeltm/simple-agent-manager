-- `status` was created in 0103 with a CHECK constraint that omitted `cancelled`.
-- Recreating this FK-parent table is forbidden by migration safety policy, so add
-- a canonical column and keep the checked legacy column compatible during writes.
ALTER TABLE debug_diagnosis_runs
  ADD COLUMN run_status TEXT NOT NULL DEFAULT 'queued'
  CHECK (run_status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled'));

UPDATE debug_diagnosis_runs SET run_status = status WHERE run_status <> status;

CREATE INDEX IF NOT EXISTS idx_debug_diagnosis_runs_canonical_status_created
  ON debug_diagnosis_runs(run_status, created_at);
CREATE INDEX IF NOT EXISTS idx_debug_diagnosis_runs_canonical_active_deadline
  ON debug_diagnosis_runs(run_status, deadline_at);
