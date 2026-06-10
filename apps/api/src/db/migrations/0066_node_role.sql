-- Add node_role column to nodes table.
-- 'workspace' = ephemeral task/dev nodes (default, existing behavior).
-- 'deployment' = long-lived app-hosting nodes (exempt from warm-pool, cron sweep, max lifetime).
ALTER TABLE nodes ADD COLUMN node_role TEXT NOT NULL DEFAULT 'workspace';
