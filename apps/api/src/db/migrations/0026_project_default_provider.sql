-- Add default_provider column to projects table.
-- Stores the user's preferred cloud provider for auto-provisioned nodes.
-- NULL means the system picks whichever credential is available.
ALTER TABLE projects ADD COLUMN default_provider TEXT;
