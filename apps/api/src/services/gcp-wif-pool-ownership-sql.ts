/**
 * SQL for `gcp-wif-pool-ownership.ts`. Kept apart so the queries and their index assumptions
 * can be read (and plan-tested) on their own.
 *
 * Tables (migration 0262):
 * - `gcp_wif_pool_index`: one row per stored cloud credential, keyed by source table + id,
 *   recording the IV it was indexed at and the pool it names (NULL when none).
 * - `gcp_wif_pool_claims`: one row per pool, the first owner whose credential named it. Claims
 *   are never released by deleting or re-pointing a credential, because the Google-side trust an
 *   earlier setup granted outlives the SAM row. An operator releases one by deleting its row.
 */

// Rows SAM has not indexed at their current IV and owner, plus rows that could not be decrypted
// and are due for another attempt. Every stored row that can be exchanged as a GCP credential is
// covered. Composable credentials do not record their provider in plaintext, so every
// cloud-provider row is indexed once; a non-GCP row is stored with a NULL pool.
//
// Every writer of `encrypted_token` encrypts with a fresh random IV (AES-GCM requires it), so an
// unchanged IV means unchanged ciphertext. The partial indexes from migration 0262
// (`idx_credentials_gcp_cloud`, `idx_cc_credentials_cloud`) keep the scan proportional to cloud
// credentials rather than to every stored credential.
//
// Binds: retry cutoff x3, page size.
export const UNINDEXED_ROWS_SQL = `
SELECT 'credentials' AS sourceTable, c.id AS sourceId, 'user' AS ownerKind, c.user_id AS ownerUserId,
       c.encrypted_token AS encryptedToken, c.iv AS iv
  FROM credentials c
 WHERE c.provider = 'gcp' AND c.credential_type = 'cloud-provider'
   AND NOT EXISTS (SELECT 1 FROM gcp_wif_pool_index i
                    WHERE i.source_table = 'credentials' AND i.source_id = c.id
                      AND i.iv = c.iv AND i.owner_kind = 'user' AND i.owner_user_id = c.user_id
                      AND (i.unreadable = 0 OR i.indexed_at >= ?))
UNION ALL
SELECT 'platform_credentials', p.id, 'platform', NULL, p.encrypted_token, p.iv
  FROM platform_credentials p
 WHERE p.provider = 'gcp' AND p.credential_type = 'cloud-provider'
   AND NOT EXISTS (SELECT 1 FROM gcp_wif_pool_index i
                    WHERE i.source_table = 'platform_credentials' AND i.source_id = p.id
                      AND i.iv = p.iv AND i.owner_kind = 'platform'
                      AND (i.unreadable = 0 OR i.indexed_at >= ?))
UNION ALL
SELECT 'cc_credentials', cc.id, 'user', cc.owner_id, cc.encrypted_token, cc.iv
  FROM cc_credentials cc
 WHERE cc.kind = 'cloud-provider'
   AND NOT EXISTS (SELECT 1 FROM gcp_wif_pool_index i
                    WHERE i.source_table = 'cc_credentials' AND i.source_id = cc.id
                      AND i.iv = cc.iv AND i.owner_kind = 'user' AND i.owner_user_id = cc.owner_id
                      AND (i.unreadable = 0 OR i.indexed_at >= ?))
LIMIT ?`;

// What decides one pool for one owner: its claim, plus at most one live credential and at most one
// deployment credential of a DIFFERENT owner naming it (one foreign holder is enough to refuse).
// Index rows of deleted credentials drop out through the existence checks. Used only when the
// unindexed-row probe in the same D1 batch (one transaction) returned nothing, so every live row
// is indexed at its current IV and owner. Inactive and disabled credentials count: they can be
// re-enabled, and Google still trusts them.
//
// Binds: pool key; pool key, owner kind, owner user id or ''; project number, pool id,
// owner kind, owner user id or ''.
export const POOL_HOLDERS_SQL = `
SELECT 'gcp_wif_pool_claims' AS sourceTable, k.pool_key AS sourceId, k.owner_kind AS ownerKind,
       k.owner_user_id AS ownerUserId
  FROM gcp_wif_pool_claims k
 WHERE k.pool_key = ?
UNION ALL
SELECT * FROM (
  SELECT i.source_table, i.source_id, i.owner_kind, i.owner_user_id
    FROM gcp_wif_pool_index i
   WHERE i.pool_key = ?
     AND NOT (i.owner_kind = ? AND COALESCE(i.owner_user_id, '') = ?)
     AND (
       (i.source_table = 'credentials' AND EXISTS (
          SELECT 1 FROM credentials c WHERE c.id = i.source_id AND c.provider = 'gcp'
             AND c.credential_type = 'cloud-provider'))
       OR (i.source_table = 'platform_credentials' AND EXISTS (
          SELECT 1 FROM platform_credentials p WHERE p.id = i.source_id AND p.provider = 'gcp'
             AND p.credential_type = 'cloud-provider'))
       OR (i.source_table = 'cc_credentials' AND EXISTS (
          SELECT 1 FROM cc_credentials cc WHERE cc.id = i.source_id AND cc.kind = 'cloud-provider'))
     )
   LIMIT 1)
UNION ALL
SELECT * FROM (
  SELECT 'project_deployment_credentials', d.id, 'user', d.user_id
    FROM project_deployment_credentials d
   WHERE d.provider = 'gcp' AND d.gcp_project_number = ? AND lower(trim(d.wif_pool_id)) = ?
     AND NOT (? = 'user' AND d.user_id = ?)
   LIMIT 1)`;

// Binds: source table, source id, iv, owner kind, owner user id, pool key, unreadable, indexed at.
export const UPSERT_INDEX_SQL = `
INSERT INTO gcp_wif_pool_index
  (source_table, source_id, iv, owner_kind, owner_user_id, pool_key, unreadable, indexed_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT (source_table, source_id) DO UPDATE SET
  iv = excluded.iv, owner_kind = excluded.owner_kind, owner_user_id = excluded.owner_user_id,
  pool_key = excluded.pool_key, unreadable = excluded.unreadable, indexed_at = excluded.indexed_at`;

// Live credentials of a different owner that could not be decrypted, at their indexed IV, and that
// could be GCP credentials: legacy and platform rows are indexed only for provider 'gcp'; a
// composable row counts only when a GCP compute configuration uses it, so a corrupt credential of
// another provider never withholds GCP claims.
const UNREADABLE_FOREIGN_ROWS = `
SELECT u.source_table AS sourceTable, u.source_id AS sourceId
  FROM gcp_wif_pool_index u
 WHERE u.unreadable = 1
   AND NOT (u.owner_kind = ? AND COALESCE(u.owner_user_id, '') = ?)
   AND (
     (u.source_table = 'credentials' AND EXISTS (
        SELECT 1 FROM credentials c WHERE c.id = u.source_id AND c.iv = u.iv))
     OR (u.source_table = 'platform_credentials' AND EXISTS (
        SELECT 1 FROM platform_credentials p WHERE p.id = u.source_id AND p.iv = u.iv))
     OR (u.source_table = 'cc_credentials' AND EXISTS (
        SELECT 1 FROM cc_credentials cc WHERE cc.id = u.source_id AND cc.iv = u.iv
           AND EXISTS (SELECT 1 FROM cc_configurations g
                        WHERE g.credential_id = cc.id AND g.consumer_target = 'gcp')))
   )`;

// Index-time claim for a credential that is already stored: first owner wins. Stored rows predate
// the check, so their claims are recorded unconditionally; withholding them would turn one
// unreadable row into refused exchanges for every existing user (rule 41).
// Binds: pool key, owner kind, owner user id, claimed at.
export const CLAIM_STORED_POOL_SQL = `
INSERT INTO gcp_wif_pool_claims (pool_key, owner_kind, owner_user_id, claimed_at)
VALUES (?, ?, ?, ?)
ON CONFLICT (pool_key) DO NOTHING`;

// Check-time first claim (a new credential naming an unclaimed pool). The primary key makes
// concurrent claims race-free. It is withheld while a live credential of a DIFFERENT owner could
// not be decrypted: that row might name this pool, and a claim granted now would outlive the key
// fix. The unreadable row is retried after `gcpWif.poolIndexUnreadableRetryMinutes`; an operator
// removes a permanently corrupt row.
// Binds: pool key, owner kind, owner user id, claimed at, owner kind, owner user id or ''.
export const CLAIM_NEW_POOL_SQL = `
INSERT INTO gcp_wif_pool_claims (pool_key, owner_kind, owner_user_id, claimed_at)
SELECT ?, ?, ?, ?
 WHERE NOT EXISTS (${UNREADABLE_FOREIGN_ROWS})
ON CONFLICT (pool_key) DO NOTHING`;

// Binds: owner kind, owner user id or ''.
export const LIST_UNREADABLE_FOREIGN_ROWS_SQL = `${UNREADABLE_FOREIGN_ROWS} LIMIT 5`;

// Binds: pool key.
export const READ_CLAIM_SQL = `
SELECT 'gcp_wif_pool_claims' AS sourceTable, pool_key AS sourceId, owner_kind AS ownerKind,
       owner_user_id AS ownerUserId
  FROM gcp_wif_pool_claims WHERE pool_key = ?`;
