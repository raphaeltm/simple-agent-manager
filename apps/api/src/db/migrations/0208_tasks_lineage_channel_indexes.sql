-- Team status reads a task's descendants level by level (`parent_task_id IN (...)`), and a
-- coordination channel's roster (`project_id = ? AND coordination_channel = ?`). Neither column
-- was indexed, so both reads scanned every task in the project. Partial indexes: most tasks have
-- neither a parent nor a coordination channel. Additive only.
CREATE INDEX IF NOT EXISTS idx_tasks_parent_task_id
ON tasks(parent_task_id)
WHERE parent_task_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_tasks_project_coordination_channel
ON tasks(project_id, coordination_channel)
WHERE coordination_channel IS NOT NULL;
