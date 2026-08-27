-- Fixed timestamp for warm-node placement claims. Unlike tasks.updated_at, this
-- does not refresh during ordinary task progress, so cleanup can protect the
-- pre-workspace-row placement race without creating an immortal task-status guard.
ALTER TABLE tasks ADD COLUMN claimed_warm_node_at TEXT;

UPDATE tasks
  SET claimed_warm_node_at = updated_at
  WHERE claimed_warm_node_id IS NOT NULL
    AND claimed_warm_node_at IS NULL;

CREATE INDEX idx_tasks_claimed_warm_node_at
  ON tasks(claimed_warm_node_id, claimed_warm_node_at)
  WHERE claimed_warm_node_id IS NOT NULL
    AND status NOT IN ('completed', 'failed', 'cancelled');
