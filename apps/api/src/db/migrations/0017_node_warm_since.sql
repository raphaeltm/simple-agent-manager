-- Migration: 0017_node_warm_since
-- Add warm_since column for warm node pooling (spec 021).
-- Nullable. ISO 8601 timestamp of when node became idle (no active workspaces).
-- Set when last workspace is destroyed; cleared when a workspace is created or claimed.

ALTER TABLE nodes ADD COLUMN warm_since TEXT DEFAULT NULL;

-- Index for efficient warm node queries (cron sweep, node selector)
CREATE INDEX IF NOT EXISTS idx_nodes_warm_since ON nodes(warm_since) WHERE warm_since IS NOT NULL;
