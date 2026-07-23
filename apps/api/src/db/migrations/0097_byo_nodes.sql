-- BYO / user-owned nodes: safety substrate (Phase 0).
-- Additive only. `node_class` defaults 'managed' so every existing node keeps its current
-- lifecycle, billing, and quota behavior. 'user-owned' rows are created later by enrollment
-- (Phase 1) and are excluded from warm-pool/teardown/metering/quota by the guards in this phase.
ALTER TABLE nodes ADD COLUMN node_class TEXT NOT NULL DEFAULT 'managed';
ALTER TABLE nodes ADD COLUMN transport TEXT;
ALTER TABLE nodes ADD COLUMN tunnel_id TEXT;
ALTER TABLE nodes ADD COLUMN tunnel_name TEXT;

-- Indexes positive lookups of enrolled machines (WHERE node_class = 'user-owned', e.g. a future
-- "list my BYO nodes" query). The cleanup/scheduling exclusions use `!=` on this low-cardinality
-- column, for which SQLite prefers the more selective existing indexes and applies node_class as a
-- cheap residual filter — so those queries do not depend on this index.
CREATE INDEX IF NOT EXISTS idx_nodes_node_class ON nodes(node_class);
