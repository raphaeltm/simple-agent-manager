-- Append-only follow-up for provider-native pool catalog identity metadata.
-- 0127 may already be applied in shared D1 environments, so new candidate-only
-- catalog fields must live in their own migration.

ALTER TABLE capacity_pool_candidates ADD COLUMN provider_instance_sku TEXT;
ALTER TABLE capacity_pool_candidates ADD COLUMN provider_instance_display_name TEXT;
ALTER TABLE capacity_pool_candidates ADD COLUMN provider_instance_catalog_source TEXT CHECK (provider_instance_catalog_source IS NULL OR provider_instance_catalog_source IN ('api', 'static'));
ALTER TABLE capacity_pool_candidates ADD COLUMN provider_instance_catalog_last_seen_at TEXT;
