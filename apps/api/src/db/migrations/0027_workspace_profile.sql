-- Add workspace_profile column to workspaces table
-- Stores whether the workspace was created as 'full' or 'lightweight'
-- Previously the UI inferred this from vmSize which was incorrect

ALTER TABLE workspaces ADD COLUMN workspace_profile TEXT DEFAULT 'full';
