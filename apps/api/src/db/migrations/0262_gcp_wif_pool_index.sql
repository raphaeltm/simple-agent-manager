-- One owner per Google Cloud workload identity pool. See services/gcp-wif-pool-ownership.ts.
-- No secret material is stored: an IV identifies a ciphertext generation, and a pool key is
-- `<projectNumber>/<poolId>`. No foreign keys: an index row references one of three tables, and
-- a claim deliberately outlives the credential that made it.
--
-- Existing credentials: pool identities are inside encrypted payloads, which SQL cannot read.
-- The Worker indexes every existing cloud credential, and claims the pools they name, on the first
-- ownership check after deploy (a token exchange or a GCP credential save). Until then the tables
-- are empty and no check trusts them: each check indexes unseen rows before it reads.

-- The pool each stored cloud credential names, keyed by source row and indexed IV.
CREATE TABLE IF NOT EXISTS gcp_wif_pool_index (
  source_table TEXT NOT NULL CHECK (source_table IN ('credentials', 'platform_credentials', 'cc_credentials')),
  source_id TEXT NOT NULL,
  iv TEXT NOT NULL,
  owner_kind TEXT NOT NULL CHECK (owner_kind IN ('user', 'platform')),
  owner_user_id TEXT,
  pool_key TEXT,
  -- 1 when the row could not be decrypted; retried after gcpWif.poolIndexUnreadableRetryMinutes.
  unreadable INTEGER NOT NULL DEFAULT 0 CHECK (unreadable IN (0, 1)),
  indexed_at TEXT NOT NULL,
  PRIMARY KEY (source_table, source_id),
  CHECK ((owner_kind = 'user' AND owner_user_id IS NOT NULL) OR (owner_kind = 'platform' AND owner_user_id IS NULL))
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_gcp_wif_pool_index_pool
  ON gcp_wif_pool_index (pool_key) WHERE pool_key IS NOT NULL;

-- The first owner whose credential named a pool. Never released by deleting or re-pointing a
-- credential: the trust an earlier setup granted in Google outlives the SAM row. An operator
-- releases a claim by deleting its row once that Google-side trust is gone.
CREATE TABLE IF NOT EXISTS gcp_wif_pool_claims (
  pool_key TEXT PRIMARY KEY NOT NULL,
  owner_kind TEXT NOT NULL CHECK (owner_kind IN ('user', 'platform')),
  owner_user_id TEXT,
  claimed_at TEXT NOT NULL,
  CHECK ((owner_kind = 'user' AND owner_user_id IS NOT NULL) OR (owner_kind = 'platform' AND owner_user_id IS NULL))
) WITHOUT ROWID;

-- Keep the unindexed-row probe proportional to cloud credentials, not to every stored
-- credential (agent keys share these tables).
CREATE INDEX IF NOT EXISTS idx_credentials_gcp_cloud
  ON credentials (id) WHERE provider = 'gcp' AND credential_type = 'cloud-provider';
CREATE INDEX IF NOT EXISTS idx_cc_credentials_cloud
  ON cc_credentials (id) WHERE kind = 'cloud-provider';
-- Deployment credentials store their pool in plaintext; the ownership check reads them directly.
CREATE INDEX IF NOT EXISTS idx_project_deployment_creds_gcp_project_number
  ON project_deployment_credentials (gcp_project_number);
