-- Per-attempt clock for workspaces in 'creating' (services/workspace-creating-deadline.ts).
-- creating_started_at: when the current create/restart/rebuild attempt entered 'creating'.
-- build_started_at: when the VM agent took the node's build slot for that attempt (first write
-- wins). Both are additive and nullable: rows from before this migration keep NULL and the
-- deadline falls back to created_at, which is what every timeout read before.
ALTER TABLE workspaces ADD COLUMN creating_started_at TEXT;
ALTER TABLE workspaces ADD COLUMN build_started_at TEXT;
