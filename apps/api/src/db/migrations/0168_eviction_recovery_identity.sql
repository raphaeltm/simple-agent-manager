ALTER TABLE session_snapshots ADD COLUMN eviction_recovery_workspace_id TEXT;
ALTER TABLE session_snapshots ADD COLUMN eviction_recovery_node_id TEXT;
ALTER TABLE session_snapshots ADD COLUMN eviction_recovery_generation TEXT;
