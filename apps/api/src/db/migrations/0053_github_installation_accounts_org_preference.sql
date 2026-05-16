-- Repair canonical GitHub App installation account metadata so duplicate
-- per-user links for the same external installation prefer organization rows.
--
-- Migration 0052 created and backfilled `github_installation_accounts`, but its
-- duplicate ranking was timestamp-only. Shared org discovery depends on
-- canonical organization rows, so an older organization link must win over a
-- newer personal duplicate for the same external installation.

WITH ranked_installations AS (
  SELECT
    installation_id,
    CASE
      WHEN lower(account_type) = 'organization' THEN 'organization'
      ELSE 'personal'
    END AS account_type,
    account_name,
    lower(account_name) AS normalized_account_name,
    created_at,
    updated_at,
    ROW_NUMBER() OVER (
      PARTITION BY installation_id
      ORDER BY
        CASE WHEN lower(account_type) = 'organization' THEN 0 ELSE 1 END,
        updated_at DESC,
        created_at DESC,
        id ASC
    ) AS rank
  FROM github_installations
  WHERE installation_id <> '0'
    AND account_name <> ''
)
INSERT INTO github_installation_accounts (
  installation_id,
  account_type,
  account_name,
  normalized_account_name,
  created_at,
  updated_at,
  uninstalled_at
)
SELECT
  installation_id,
  account_type,
  account_name,
  normalized_account_name,
  created_at,
  updated_at,
  NULL
FROM ranked_installations
WHERE rank = 1
ON CONFLICT(installation_id) DO UPDATE SET
  account_type = excluded.account_type,
  account_name = excluded.account_name,
  normalized_account_name = excluded.normalized_account_name,
  updated_at = excluded.updated_at,
  uninstalled_at = NULL;
