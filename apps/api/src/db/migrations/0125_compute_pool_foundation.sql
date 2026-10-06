-- Compute/capacity pool durable schema foundation.
-- Additive-only migration: no table rebuilds, drops, or destructive data movement.
--
-- Internal naming uses "capacity" rather than "node" or "compute" so the schema can model
-- VM nodes, registered runners, and instant/container runtimes without product wording churn.

CREATE TABLE IF NOT EXISTS capacity_sources (
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
          AND credential_id IS NOT NULL
          AND platform_credential_id IS NULL
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

CREATE TABLE IF NOT EXISTS capacity_pools (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL CHECK (scope IN ('installation', 'user', 'project')),
  owner_user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  owner_project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled', 'deleted')),
  strategy TEXT NOT NULL DEFAULT 'balanced' CHECK (
    strategy IN ('balanced', 'pack', 'spread', 'smallest-fit')
  ),
  exhaustion_policy TEXT NOT NULL DEFAULT 'queue' CHECK (
    exhaustion_policy IN ('queue', 'fail', 'fallback-chain')
  ),
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (
    (scope = 'installation' AND owner_user_id IS NULL AND owner_project_id IS NULL)
    OR (scope = 'user' AND owner_user_id IS NOT NULL AND owner_project_id IS NULL)
    OR (scope = 'project' AND owner_user_id IS NULL AND owner_project_id IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_capacity_pools_default_installation
  ON capacity_pools(scope)
  WHERE scope = 'installation' AND is_default = 1;

CREATE UNIQUE INDEX IF NOT EXISTS idx_capacity_pools_default_user
  ON capacity_pools(owner_user_id)
  WHERE scope = 'user' AND is_default = 1;

CREATE UNIQUE INDEX IF NOT EXISTS idx_capacity_pools_default_project
  ON capacity_pools(owner_project_id)
  WHERE scope = 'project' AND is_default = 1;

CREATE INDEX IF NOT EXISTS idx_capacity_pools_scope_status
  ON capacity_pools(scope, status);

CREATE TABLE IF NOT EXISTS capacity_pool_candidates (
  id TEXT PRIMARY KEY,
  pool_id TEXT NOT NULL REFERENCES capacity_pools(id) ON DELETE CASCADE,
  capacity_source_id TEXT NOT NULL REFERENCES capacity_sources(id) ON DELETE CASCADE,
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
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_capacity_pool_candidates_pool_status_order
  ON capacity_pool_candidates(pool_id, status, priority, candidate_order);

CREATE INDEX IF NOT EXISTS idx_capacity_pool_candidates_source
  ON capacity_pool_candidates(capacity_source_id);

CREATE TABLE IF NOT EXISTS capacity_pool_fallbacks (
  pool_id TEXT NOT NULL REFERENCES capacity_pools(id) ON DELETE CASCADE,
  fallback_pool_id TEXT NOT NULL REFERENCES capacity_pools(id) ON DELETE CASCADE,
  fallback_order INTEGER NOT NULL DEFAULT 0 CHECK (fallback_order >= 0),
  condition TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (pool_id, fallback_pool_id),
  CHECK (pool_id <> fallback_pool_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_capacity_pool_fallbacks_order
  ON capacity_pool_fallbacks(pool_id, fallback_order);

ALTER TABLE nodes ADD COLUMN capacity_pool_id TEXT REFERENCES capacity_pools(id) ON DELETE SET NULL;
ALTER TABLE nodes ADD COLUMN capacity_pool_scope TEXT CHECK (
  capacity_pool_scope IS NULL OR capacity_pool_scope IN ('installation', 'user', 'project')
);
ALTER TABLE nodes ADD COLUMN capacity_pool_revision INTEGER CHECK (
  capacity_pool_revision IS NULL OR capacity_pool_revision >= 1
);
ALTER TABLE nodes ADD COLUMN capacity_source_id TEXT REFERENCES capacity_sources(id) ON DELETE SET NULL;
ALTER TABLE nodes ADD COLUMN placement_credential_source TEXT CHECK (
  placement_credential_source IS NULL
  OR placement_credential_source IN ('user', 'project', 'platform', 'self-hosted')
);
ALTER TABLE nodes ADD COLUMN placement_credential_reference TEXT;
ALTER TABLE nodes ADD COLUMN placement_credential_version INTEGER;
ALTER TABLE nodes ADD COLUMN capacity_pool_project_id TEXT REFERENCES projects(id) ON DELETE SET NULL;
ALTER TABLE nodes ADD COLUMN workload_role TEXT CHECK (
  workload_role IS NULL OR workload_role IN ('workspace', 'deployment')
);
ALTER TABLE nodes ADD COLUMN placement_explanation_json TEXT;

CREATE INDEX IF NOT EXISTS idx_nodes_capacity_pool
  ON nodes(capacity_pool_id)
  WHERE capacity_pool_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_nodes_capacity_source
  ON nodes(capacity_source_id)
  WHERE capacity_source_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_nodes_capacity_pool_project
  ON nodes(capacity_pool_project_id)
  WHERE capacity_pool_project_id IS NOT NULL;

ALTER TABLE workspaces ADD COLUMN capacity_pool_id TEXT REFERENCES capacity_pools(id) ON DELETE SET NULL;
ALTER TABLE workspaces ADD COLUMN capacity_pool_scope TEXT CHECK (
  capacity_pool_scope IS NULL OR capacity_pool_scope IN ('installation', 'user', 'project')
);
ALTER TABLE workspaces ADD COLUMN capacity_pool_revision INTEGER CHECK (
  capacity_pool_revision IS NULL OR capacity_pool_revision >= 1
);
ALTER TABLE workspaces ADD COLUMN capacity_source_id TEXT REFERENCES capacity_sources(id) ON DELETE SET NULL;
ALTER TABLE workspaces ADD COLUMN placement_credential_source TEXT CHECK (
  placement_credential_source IS NULL
  OR placement_credential_source IN ('user', 'project', 'platform', 'self-hosted')
);
ALTER TABLE workspaces ADD COLUMN placement_credential_reference TEXT;
ALTER TABLE workspaces ADD COLUMN placement_credential_version INTEGER;
ALTER TABLE workspaces ADD COLUMN capacity_pool_project_id TEXT REFERENCES projects(id) ON DELETE SET NULL;
ALTER TABLE workspaces ADD COLUMN workload_role TEXT CHECK (
  workload_role IS NULL OR workload_role IN ('workspace', 'deployment')
);

CREATE INDEX IF NOT EXISTS idx_workspaces_capacity_pool
  ON workspaces(capacity_pool_id)
  WHERE capacity_pool_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_workspaces_capacity_source
  ON workspaces(capacity_source_id)
  WHERE capacity_source_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_workspaces_capacity_pool_project
  ON workspaces(capacity_pool_project_id)
  WHERE capacity_pool_project_id IS NOT NULL;

ALTER TABLE tasks ADD COLUMN capacity_pool_id TEXT REFERENCES capacity_pools(id) ON DELETE SET NULL;
ALTER TABLE tasks ADD COLUMN capacity_pool_scope TEXT CHECK (
  capacity_pool_scope IS NULL OR capacity_pool_scope IN ('installation', 'user', 'project')
);
ALTER TABLE tasks ADD COLUMN capacity_pool_revision INTEGER CHECK (
  capacity_pool_revision IS NULL OR capacity_pool_revision >= 1
);
ALTER TABLE tasks ADD COLUMN capacity_source_id TEXT REFERENCES capacity_sources(id) ON DELETE SET NULL;
ALTER TABLE tasks ADD COLUMN placement_credential_source TEXT CHECK (
  placement_credential_source IS NULL
  OR placement_credential_source IN ('user', 'project', 'platform', 'self-hosted')
);
ALTER TABLE tasks ADD COLUMN placement_credential_reference TEXT;
ALTER TABLE tasks ADD COLUMN placement_credential_version INTEGER;
ALTER TABLE tasks ADD COLUMN capacity_pool_project_id TEXT REFERENCES projects(id) ON DELETE SET NULL;
ALTER TABLE tasks ADD COLUMN workload_role TEXT CHECK (
  workload_role IS NULL OR workload_role IN ('workspace', 'deployment')
);

CREATE INDEX IF NOT EXISTS idx_tasks_capacity_pool
  ON tasks(capacity_pool_id)
  WHERE capacity_pool_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_tasks_capacity_source
  ON tasks(capacity_source_id)
  WHERE capacity_source_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_tasks_capacity_pool_project
  ON tasks(capacity_pool_project_id)
  WHERE capacity_pool_project_id IS NOT NULL;
