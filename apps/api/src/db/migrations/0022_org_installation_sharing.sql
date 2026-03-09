-- Allow multiple users to reference the same GitHub App installation.
-- Previously, installation_id had a UNIQUE constraint meaning only
-- the user who installed the app got a record. Now we use a composite
-- unique on (user_id, installation_id) so each org member gets their own row.

-- Drop the old unique index on installation_id
DROP INDEX IF EXISTS github_installations_installation_id_unique;

-- Add composite unique index: one row per user per installation
CREATE UNIQUE INDEX IF NOT EXISTS idx_github_installations_user_installation
  ON github_installations (user_id, installation_id);
