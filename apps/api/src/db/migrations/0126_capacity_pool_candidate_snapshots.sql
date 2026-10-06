-- Add selected capacity-pool candidate audit snapshots.
--
-- These columns intentionally store the candidate id as a nullable snapshot. Existing
-- provider/location/size columns remain the durable provider-facing audit fields, so later pool
-- edits do not rewrite historical task/node/workspace placement records.

ALTER TABLE nodes ADD COLUMN capacity_pool_candidate_id TEXT;
ALTER TABLE workspaces ADD COLUMN capacity_pool_candidate_id TEXT;
ALTER TABLE tasks ADD COLUMN capacity_pool_candidate_id TEXT;

CREATE INDEX IF NOT EXISTS idx_nodes_capacity_pool_candidate
  ON nodes(capacity_pool_candidate_id)
  WHERE capacity_pool_candidate_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_workspaces_capacity_pool_candidate
  ON workspaces(capacity_pool_candidate_id)
  WHERE capacity_pool_candidate_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_tasks_capacity_pool_candidate
  ON tasks(capacity_pool_candidate_id)
  WHERE capacity_pool_candidate_id IS NOT NULL;
