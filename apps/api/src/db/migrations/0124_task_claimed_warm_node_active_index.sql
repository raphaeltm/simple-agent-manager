-- Migration 0123 used a broader terminal-status exclusion than the cleanup
-- query's exact active-status predicate. SQLite cannot use that partial index
-- for the correlated placement guard, so rebuild it with the runtime predicate.
DROP INDEX IF EXISTS idx_tasks_claimed_warm_node_at;

CREATE INDEX idx_tasks_claimed_warm_node_at
  ON tasks(claimed_warm_node_id, claimed_warm_node_at)
  WHERE claimed_warm_node_id IS NOT NULL
    AND status IN ('queued', 'delegated', 'in_progress');
