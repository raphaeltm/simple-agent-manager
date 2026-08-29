-- Allow capacity sources to reference composable credential attachments without a
-- legacy credentials row.
--
-- SQLite cannot relax a CHECK constraint in place. This rebuild copies both the
-- parent table and its child candidate table before dropping either original
-- table. Dropping the old child first avoids the cascade-loss class from prior
-- parent-table rebuild incidents while keeping foreign keys enabled.

CREATE TABLE capacity_sources_new (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL CHECK (scope IN ('installation', 'user', 'project')),
  owner_user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  owner_project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  source_kind TEXT NOT NULL CHECK (
    source_kind IN ('cloud-provider-credential', 'registered-runner', 'instant-runtime')
  ),
  provider TEXT,
  credential_source TEXT CHECK (
    credential_source IS NULL OR credential_source IN ('user', 'project', 'platform')
  ),
  credential_id TEXT REFERENCES credentials(id) ON DELETE CASCADE,
  platform_credential_id TEXT REFERENCES platform_credentials(id) ON DELETE CASCADE,
  credential_reference TEXT,
  credential_version INTEGER,
  external_source_ref TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled', 'deleted')),
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (
    (scope = 'installation' AND owner_user_id IS NULL AND owner_project_id IS NULL)
    OR (scope = 'user' AND owner_user_id IS NOT NULL AND owner_project_id IS NULL)
    OR (scope = 'project' AND owner_user_id IS NULL AND owner_project_id IS NOT NULL)
  ),
  CHECK (
    (
      source_kind = 'cloud-provider-credential'
      AND provider IS NOT NULL
      AND credential_source IS NOT NULL
      AND (
        (
          credential_source IN ('user', 'project')
          AND platform_credential_id IS NULL
          AND (
            credential_id IS NOT NULL
            OR (credential_reference IS NOT NULL AND external_source_ref IS NOT NULL)
          )
        )
        OR (
          credential_source = 'platform'
          AND credential_id IS NULL
          AND platform_credential_id IS NOT NULL
        )
      )
    )
    OR (
      source_kind != 'cloud-provider-credential'
      AND credential_source IS NULL
      AND credential_id IS NULL
      AND platform_credential_id IS NULL
    )
  )
);

INSERT INTO capacity_sources_new (
  id,
  scope,
  owner_user_id,
  owner_project_id,
  source_kind,
  provider,
  credential_source,
  credential_id,
  platform_credential_id,
  credential_reference,
  credential_version,
  external_source_ref,
  status,
  created_by,
  created_at,
  updated_at
)
SELECT
  id,
  scope,
  owner_user_id,
  owner_project_id,
  source_kind,
  provider,
  credential_source,
  credential_id,
  platform_credential_id,
  credential_reference,
  credential_version,
  external_source_ref,
  status,
  created_by,
  created_at,
  updated_at
FROM capacity_sources;

CREATE TABLE capacity_pool_candidates_new (
  id TEXT PRIMARY KEY,
  pool_id TEXT NOT NULL REFERENCES capacity_pools(id) ON DELETE CASCADE,
  capacity_source_id TEXT NOT NULL REFERENCES capacity_sources_new(id) ON DELETE CASCADE,
  provider TEXT,
  location TEXT,
  workload_role TEXT NOT NULL DEFAULT 'workspace' CHECK (
    workload_role IN ('workspace', 'deployment')
  ),
  runtime TEXT,
  machine_class TEXT,
  machine_size TEXT,
  priority INTEGER NOT NULL DEFAULT 0,
  candidate_order INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled', 'deleted')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  provider_instance_type TEXT,
  provider_instance_vcpu_count INTEGER,
  provider_instance_memory_mb INTEGER,
  provider_instance_disk_gb INTEGER,
  provider_instance_price_display TEXT,
  provider_instance_price_currency TEXT,
  provider_instance_price_monthly_cents INTEGER,
  provider_instance_price_hourly_micros INTEGER,
  provider_instance_sku TEXT,
  provider_instance_display_name TEXT,
  provider_instance_catalog_source TEXT CHECK (
    provider_instance_catalog_source IS NULL
    OR provider_instance_catalog_source IN ('api', 'static')
  ),
  provider_instance_catalog_last_seen_at TEXT
);

INSERT INTO capacity_pool_candidates_new (
  id,
  pool_id,
  capacity_source_id,
  provider,
  location,
  workload_role,
  runtime,
  machine_class,
  machine_size,
  priority,
  candidate_order,
  status,
  created_at,
  updated_at,
  provider_instance_type,
  provider_instance_vcpu_count,
  provider_instance_memory_mb,
  provider_instance_disk_gb,
  provider_instance_price_display,
  provider_instance_price_currency,
  provider_instance_price_monthly_cents,
  provider_instance_price_hourly_micros,
  provider_instance_sku,
  provider_instance_display_name,
  provider_instance_catalog_source,
  provider_instance_catalog_last_seen_at
)
SELECT
  id,
  pool_id,
  capacity_source_id,
  provider,
  location,
  workload_role,
  runtime,
  machine_class,
  machine_size,
  priority,
  candidate_order,
  status,
  created_at,
  updated_at,
  provider_instance_type,
  provider_instance_vcpu_count,
  provider_instance_memory_mb,
  provider_instance_disk_gb,
  provider_instance_price_display,
  provider_instance_price_currency,
  provider_instance_price_monthly_cents,
  provider_instance_price_hourly_micros,
  provider_instance_sku,
  provider_instance_display_name,
  provider_instance_catalog_source,
  provider_instance_catalog_last_seen_at
FROM capacity_pool_candidates;

DROP TABLE capacity_pool_candidates;
DROP TABLE capacity_sources;

ALTER TABLE capacity_sources_new RENAME TO capacity_sources;
ALTER TABLE capacity_pool_candidates_new RENAME TO capacity_pool_candidates;

CREATE INDEX IF NOT EXISTS idx_capacity_sources_owner_user
  ON capacity_sources(owner_user_id)
  WHERE owner_user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_capacity_sources_owner_project
  ON capacity_sources(owner_project_id)
  WHERE owner_project_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_capacity_sources_credential
  ON capacity_sources(credential_id)
  WHERE credential_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_capacity_sources_platform_credential
  ON capacity_sources(platform_credential_id)
  WHERE platform_credential_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_capacity_pool_candidates_pool_status_order
  ON capacity_pool_candidates(pool_id, status, priority, candidate_order);

CREATE INDEX IF NOT EXISTS idx_capacity_pool_candidates_source
  ON capacity_pool_candidates(capacity_source_id);
