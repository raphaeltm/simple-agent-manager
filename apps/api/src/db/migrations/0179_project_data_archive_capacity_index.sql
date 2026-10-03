-- Capacity backpressure for ProjectData archive sharding
-- (src/scheduled/project-data-archive-capacity-policy.ts) asks, for a project or one target
-- shard, whether a capacity failure (`error_code` 'storage_full' or 'storage_full_target') has
-- a later journal that got past the failed write. The existing (project_id, state, updated_at)
-- index finds the failed rows, but the "recovered" check then reads every journal row of the
-- project, once per capacity failure, for every candidate the sweep evaluates during an
-- incident. Leading on (project_id, error_code) keeps both checks to the capacity rows.
--
-- Additive only: one new index, no table change.

CREATE INDEX IF NOT EXISTS idx_project_data_archive_migrations_capacity
  ON project_data_archive_migrations (project_id, error_code, state, updated_at);
