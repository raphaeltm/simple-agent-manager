-- Canonical GitHub App installation account state.
--
-- `github_installations` remains the per-user SAM linkage table. Shared
-- organization discovery must not depend on those per-user rows because user
-- unlink/account deletion may remove them. This table is keyed by GitHub's
-- external installation id and is removed/tombstoned only when GitHub sends an
-- installation.deleted webhook.

CREATE TABLE IF NOT EXISTS github_installation_accounts (
  installation_id TEXT PRIMARY KEY,
  account_type TEXT NOT NULL,
  account_name TEXT NOT NULL,
  account_name_normalized TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  uninstalled_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_github_installation_accounts_active_lookup
  ON github_installation_accounts (account_type, account_name_normalized)
  WHERE uninstalled_at IS NULL;

WITH ranked_installations AS (
  SELECT
    installation_id,
    CASE
      WHEN lower(account_type) = 'organization' THEN 'organization'
      ELSE 'personal'
    END AS account_type,
    account_name,
    lower(account_name) AS account_name_normalized,
    created_at,
    updated_at,
    ROW_NUMBER() OVER (
      PARTITION BY installation_id
      ORDER BY updated_at DESC, created_at DESC, id ASC
    ) AS rank
  FROM github_installations
  WHERE installation_id <> '0'
    AND account_name <> ''
)
INSERT INTO github_installation_accounts (
  installation_id,
  account_type,
  account_name,
  account_name_normalized,
  created_at,
  updated_at,
  uninstalled_at
)
SELECT
  installation_id,
  account_type,
  account_name,
  account_name_normalized,
  created_at,
  updated_at,
  NULL
FROM ranked_installations
WHERE rank = 1
ON CONFLICT(installation_id) DO UPDATE SET
  account_type = excluded.account_type,
  account_name = excluded.account_name,
  account_name_normalized = excluded.account_name_normalized,
  updated_at = excluded.updated_at,
  uninstalled_at = NULL;
