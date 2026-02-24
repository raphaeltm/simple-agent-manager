-- Migration: Add default VM size to projects
-- Allows projects to specify a default VM size for new workspaces.
-- NULL means "use platform default" (currently 'medium').

ALTER TABLE projects ADD COLUMN default_vm_size TEXT DEFAULT NULL;
