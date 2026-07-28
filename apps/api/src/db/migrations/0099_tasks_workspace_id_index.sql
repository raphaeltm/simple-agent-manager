-- Index tasks by workspace_id for the mass-outage Instant recovery hot path.
-- persistRuntimeRecoveryFailed and other workspace-scoped task lookups run
-- `SELECT ... FROM tasks WHERE workspace_id = ? AND status IN (...)`, which
-- previously required a full table scan. Partial (workspace_id IS NOT NULL)
-- because most tasks never bind a workspace; the predicate still serves every
-- `workspace_id = ?` lookup since the bound value is always non-null.
CREATE INDEX IF NOT EXISTS idx_tasks_workspace_id
  ON tasks(workspace_id) WHERE workspace_id IS NOT NULL;
