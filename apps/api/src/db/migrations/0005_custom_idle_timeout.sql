-- Add idleTimeoutSeconds field to workspaces table
-- Default: 1800 seconds (30 minutes)
-- Allows custom idle timeout per workspace
ALTER TABLE workspaces ADD COLUMN idle_timeout_seconds INTEGER NOT NULL DEFAULT 1800;