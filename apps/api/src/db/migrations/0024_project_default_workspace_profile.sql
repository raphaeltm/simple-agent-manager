-- Add default_workspace_profile column to projects table
-- Allows per-project workspace profile selection ('full' or 'lightweight')
-- 'lightweight' skips devcontainer build for faster startup (~20s vs ~2min)
-- Nullable: when NULL, falls back to platform default ('full')
ALTER TABLE projects ADD COLUMN default_workspace_profile TEXT;
