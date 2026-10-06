-- Add a non-unique external GitHub installation id column.
-- The legacy installation_id column still has a table-level UNIQUE constraint
-- in deployed SQLite databases, so new per-user duplicate links store a
-- deterministic per-user key there and keep the real GitHub installation id
-- in external_installation_id.

ALTER TABLE github_installations ADD COLUMN external_installation_id TEXT;

UPDATE github_installations
SET external_installation_id = installation_id
WHERE external_installation_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_github_installations_external_installation_id
  ON github_installations (external_installation_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_github_installations_user_external_installation
  ON github_installations (user_id, external_installation_id)
  WHERE external_installation_id IS NOT NULL;
