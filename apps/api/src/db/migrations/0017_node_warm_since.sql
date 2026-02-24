-- Migration: 0017_node_warm_since
-- Add warm_since column for warm node pooling (spec 021).
-- Nullable. ISO 8601 timestamp of when node became idle (no active workspaces).
-- Set when last workspace is destroyed; cleared when a workspace is created or claimed.

ALTER TABLE nodes ADD COLUMN warm_since TEXT DEFAULT NULL;
