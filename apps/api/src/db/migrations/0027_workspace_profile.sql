-- Add workspace_profile column to workspaces table
-- Stores whether the workspace was created as 'full' or 'lightweight'
-- Previously the UI inferred this from vmSize which was incorrect

-- 'full' matches DEFAULT_WORKSPACE_PROFILE in packages/shared/src/constants.ts — keep in sync.
-- Pre-existing workspaces default to 'full' since the profile was never stored before this migration.
ALTER TABLE workspaces ADD COLUMN workspace_profile TEXT DEFAULT 'full';
