ALTER TABLE capacity_pools ADD COLUMN max_nodes INTEGER NOT NULL DEFAULT 3;

CREATE INDEX IF NOT EXISTS idx_nodes_capacity_pool_user_status
  ON nodes(capacity_pool_id, user_id, status)
  WHERE capacity_pool_id IS NOT NULL;

-- The VM admission lease is provider-domain scoped, while one pool may contain
-- several providers. Enforce the final per-user pool ceiling in the same SQLite
-- statement that creates a managed workspace-node placeholder so cross-provider
-- contenders cannot both pass a read-then-insert race.
CREATE TRIGGER IF NOT EXISTS trg_nodes_capacity_pool_max_nodes
BEFORE INSERT ON nodes
WHEN NEW.capacity_pool_id IS NOT NULL
  AND NEW.node_role = 'workspace'
  AND NEW.node_class != 'user-owned'
  AND NEW.status IN ('running', 'creating', 'recovery')
  AND (
    SELECT COUNT(*)
      FROM nodes
     WHERE capacity_pool_id = NEW.capacity_pool_id
       AND user_id = NEW.user_id
       AND node_role = 'workspace'
       AND node_class != 'user-owned'
       AND status IN ('running', 'creating', 'recovery')
  ) >= COALESCE(
    (SELECT max_nodes FROM capacity_pools WHERE id = NEW.capacity_pool_id),
    3
  )
BEGIN
  SELECT RAISE(ABORT, 'capacity_pool_node_limit');
END;
