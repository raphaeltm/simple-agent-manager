-- Persist warm-node ownership before the NodeLifecycle DO cancels the teardown
-- alarm. This lets a retried TaskRunner find and release an exact claim even if
-- it crashed between the DO RPC and its own storage write.
ALTER TABLE tasks ADD COLUMN claimed_warm_node_id TEXT REFERENCES nodes(id) ON DELETE SET NULL;

-- A warm node has exactly one durable claimant. This closes the cross-store
-- crash window where D1 recorded a claim but the NodeLifecycle storage write
-- had not committed yet and another task attempted to claim the same node.
CREATE UNIQUE INDEX idx_tasks_claimed_warm_node_unique
  ON tasks(claimed_warm_node_id)
  WHERE claimed_warm_node_id IS NOT NULL
    AND status NOT IN ('completed', 'failed', 'cancelled');
