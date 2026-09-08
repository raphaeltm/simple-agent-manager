-- Separate monotonic refresh fencing from semantic placement authority.
-- source_generation/catalog_generation remain refresh-order fences. The new
-- authority columns are stable across identical refreshes and change only when
-- placement-relevant source/candidate/settings/pool semantics change.

ALTER TABLE capacity_sources
  ADD COLUMN authority_generation INTEGER NOT NULL DEFAULT 0 CHECK (authority_generation >= 0);

ALTER TABLE capacity_pool_candidates
  ADD COLUMN authority_generation INTEGER NOT NULL DEFAULT 0 CHECK (authority_generation >= 0);

ALTER TABLE tasks
  ADD COLUMN selection_settings_version INTEGER CHECK (
    selection_settings_version IS NULL OR selection_settings_version >= 0
  );

ALTER TABLE tasks
  ADD COLUMN capacity_authority_generation INTEGER CHECK (
    capacity_authority_generation IS NULL OR capacity_authority_generation >= 0
  );

ALTER TABLE nodes
  ADD COLUMN selection_settings_version INTEGER CHECK (
    selection_settings_version IS NULL OR selection_settings_version >= 0
  );

ALTER TABLE nodes
  ADD COLUMN capacity_authority_generation INTEGER CHECK (
    capacity_authority_generation IS NULL OR capacity_authority_generation >= 0
  );

ALTER TABLE workspaces
  ADD COLUMN selection_settings_version INTEGER CHECK (
    selection_settings_version IS NULL OR selection_settings_version >= 0
  );

ALTER TABLE workspaces
  ADD COLUMN capacity_authority_generation INTEGER CHECK (
    capacity_authority_generation IS NULL OR capacity_authority_generation >= 0
  );

CREATE INDEX IF NOT EXISTS idx_capacity_sources_authority_generation
  ON capacity_sources(authority_generation);

CREATE INDEX IF NOT EXISTS idx_capacity_pool_candidates_authority_generation
  ON capacity_pool_candidates(capacity_source_id, authority_generation);

CREATE INDEX IF NOT EXISTS idx_tasks_capacity_authority_generation
  ON tasks(capacity_authority_generation)
  WHERE capacity_authority_generation IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_nodes_capacity_authority_generation
  ON nodes(capacity_authority_generation)
  WHERE capacity_authority_generation IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_workspaces_capacity_authority_generation
  ON workspaces(capacity_authority_generation)
  WHERE capacity_authority_generation IS NOT NULL;
