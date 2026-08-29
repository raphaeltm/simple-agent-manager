-- Provider-native compute-pool catalog read-path indexes.
--
-- This migration is intentionally additive only. Capacity sources for
-- composable credentials keep using the shipped 0125 capacity_sources CHECK by
-- storing a distinct, non-user-facing mirror row in credentials. That avoids
-- rebuilding capacity_sources, which is a foreign-key parent table.

CREATE INDEX IF NOT EXISTS idx_credentials_cloud_provider_project_active
  ON credentials(project_id, provider, is_active)
  WHERE credential_type = 'cloud-provider' AND project_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_credentials_cloud_provider_user_project_active
  ON credentials(user_id, project_id, provider, is_active)
  WHERE credential_type = 'cloud-provider';

CREATE INDEX IF NOT EXISTS idx_cc_attachments_project_compute_active
  ON cc_attachments(project_id, consumer_kind, consumer_target, is_active)
  WHERE project_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_capacity_pool_candidates_pool_order
  ON capacity_pool_candidates(pool_id, priority, candidate_order, id);
