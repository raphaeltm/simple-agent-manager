-- Canonical GitHub App installation account state.
--
-- `github_installations` remains the per-user SAM linkage table. Do not use
-- account deletion or per-user unlink flows to remove rows from this table:
-- shared organization installation discovery depends on this canonical state.

CREATE TABLE IF NOT EXISTS github_installation_accounts (
  installation_id TEXT PRIMARY KEY,
  account_type TEXT NOT NULL,
  account_name TEXT NOT NULL,
  normalized_account_name TEXT NOT NULL,
  uninstalled_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_github_installation_accounts_lookup
  ON github_installation_accounts (account_type, normalized_account_name)
  WHERE uninstalled_at IS NULL;

INSERT INTO github_installation_accounts (
  installation_id,
  account_type,
  account_name,
  normalized_account_name,
  uninstalled_at,
  created_at,
  updated_at
)
SELECT
  installation_id,
  account_type,
  account_name,
  lower(account_name),
  NULL,
  created_at,
  updated_at
FROM (
  SELECT
    installation_id,
    CASE
      WHEN SUM(CASE WHEN lower(account_type) = 'organization' THEN 1 ELSE 0 END) > 0
        THEN 'organization'
      ELSE lower(MIN(account_type))
    END AS account_type,
    COALESCE(MAX(NULLIF(account_name, '')), MIN(account_name), '') AS account_name,
    MIN(created_at) AS created_at,
    MAX(updated_at) AS updated_at
  FROM github_installations
  WHERE installation_id <> '0'
  GROUP BY installation_id
)
WHERE true
ON CONFLICT(installation_id) DO UPDATE SET
  account_type = excluded.account_type,
  account_name = excluded.account_name,
  normalized_account_name = excluded.normalized_account_name,
  uninstalled_at = NULL,
  updated_at = excluded.updated_at;
