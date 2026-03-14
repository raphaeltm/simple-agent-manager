-- Add cloud_provider column to nodes table.
-- Stores which provider was used to create the node so that
-- provisioning, lifecycle operations, and cleanup use the correct credentials.
-- NULL for nodes created before this migration (they used whichever credential was first).
ALTER TABLE nodes ADD COLUMN cloud_provider TEXT;
