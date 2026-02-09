-- Rollback script for 0006_dual_credentials_oauth_support.sql
-- This removes the OAuth support columns added in migration 0006

-- WARNING: This will permanently delete all OAuth tokens and credential status data
-- Only run this if you need to completely remove OAuth support

-- Remove the new columns
ALTER TABLE credentials DROP COLUMN credential_kind;
ALTER TABLE credentials DROP COLUMN is_active;

-- Note: After running this rollback:
-- 1. All OAuth tokens will be lost
-- 2. The system will revert to single API key per agent
-- 3. You may need to update application code to remove OAuth references