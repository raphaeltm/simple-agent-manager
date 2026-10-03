-- Durable capacity holds for ProjectData archive sharding
-- (src/scheduled/project-data-archive-capacity-policy.ts).
--
-- When an archive call fails because a Durable Object is at Cloudflare's per-object storage cap,
-- the coordinator records a hold on that object: the project's root (`object_kind = 'root'`,
-- `owner_name` = the project id) or one target archive shard (`'target'`, the shard's owner
-- name). While a hold is active, the sweep fences no new session into that object and retries
-- only one of its failed migrations per run. A hold clears only when a probe of its object
-- measures room under the hard cap; each global sweep probes the holds it probed least recently
-- (`last_probed_at`), so an object whose probe keeps failing cannot starve the others. A hold
-- that neither a failure nor a still-full probe refreshes expires on its own (`last_failure_at`
-- age), so it cannot strand a project.
--
-- Additive only: one new table and its index. No existing table changes.

CREATE TABLE IF NOT EXISTS project_data_archive_capacity_holds (
  object_kind TEXT NOT NULL CHECK (object_kind IN ('root', 'target')),
  owner_name TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  opened_at INTEGER NOT NULL,
  last_failure_at INTEGER NOT NULL,
  last_failure_migration_id TEXT,
  failure_count INTEGER NOT NULL DEFAULT 1,
  last_probed_at INTEGER,
  PRIMARY KEY (object_kind, owner_name)
);

CREATE INDEX IF NOT EXISTS idx_project_data_archive_capacity_holds_project
  ON project_data_archive_capacity_holds (project_id);
