-- BYO / user-owned nodes: safety substrate (Phase 0).
-- Additive only. `node_class` defaults 'managed' so every existing node keeps its current
-- lifecycle, billing, and quota behavior. 'user-owned' rows are created later by enrollment
-- (Phase 1) and are excluded from warm-pool/teardown/metering/quota by the guards in this phase.
ALTER TABLE nodes ADD COLUMN node_class TEXT NOT NULL DEFAULT 'managed';
ALTER TABLE nodes ADD COLUMN transport TEXT;
ALTER TABLE nodes ADD COLUMN tunnel_id TEXT;
ALTER TABLE nodes ADD COLUMN tunnel_name TEXT;

-- Cleanup/scheduling queries filter on node_class to exclude user-owned nodes.
CREATE INDEX IF NOT EXISTS idx_nodes_node_class ON nodes(node_class);
