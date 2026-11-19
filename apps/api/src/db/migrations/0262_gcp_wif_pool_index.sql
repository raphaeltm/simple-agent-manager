-- Which Google Cloud workload identity pool each stored cloud credential names, so a pool can be
-- held by one owner (one SAM user, or the installation). See services/gcp-wif-pool-ownership.ts.
-- Pool identities live inside encrypted payloads, so the Worker fills this table itself: every
-- ownership check indexes rows whose IV it has not seen, and reads owners only through rows whose
-- source credential still has the indexed IV. Existing credentials are indexed on the first check
-- after deploy; nothing here can decrypt them. No secret material is stored: the IV identifies a
-- ciphertext generation, the pool key is `<projectNumber>/<poolId>`.
-- No foreign keys: a row references one of three tables, and deletions drop out of the owner read.
CREATE TABLE IF NOT EXISTS gcp_wif_pool_index (
  source_table TEXT NOT NULL CHECK (source_table IN ('credentials', 'platform_credentials', 'cc_credentials')),
  source_id TEXT NOT NULL,
  iv TEXT NOT NULL,
  owner_kind TEXT NOT NULL CHECK (owner_kind IN ('user', 'platform')),
  owner_user_id TEXT,
  pool_key TEXT,
  indexed_at TEXT NOT NULL,
  PRIMARY KEY (source_table, source_id),
  CHECK ((owner_kind = 'user' AND owner_user_id IS NOT NULL) OR (owner_kind = 'platform' AND owner_user_id IS NULL))
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_gcp_wif_pool_index_pool
  ON gcp_wif_pool_index (pool_key) WHERE pool_key IS NOT NULL;
-- Deployment credentials store their pool in plaintext; the ownership check reads them directly.
CREATE INDEX IF NOT EXISTS idx_project_deployment_creds_gcp_project_number
  ON project_deployment_credentials (gcp_project_number);
