-- Record the admin who most recently rotated an encrypted platform credential.
-- Existing rows remain valid and status resolution falls back to created_by.
ALTER TABLE platform_credentials ADD COLUMN updated_by TEXT REFERENCES users(id);
