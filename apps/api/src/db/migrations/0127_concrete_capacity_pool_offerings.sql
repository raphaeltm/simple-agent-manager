-- Store provider-native compute-pool offering identity and normalized resource metadata.
-- Existing rows are left in place for audit/history; default pool reconciliation will
-- upsert concrete candidates and disable stale abstract-size candidate IDs.

ALTER TABLE capacity_pool_candidates ADD COLUMN provider_instance_type TEXT;
ALTER TABLE capacity_pool_candidates ADD COLUMN provider_instance_sku TEXT;
ALTER TABLE capacity_pool_candidates ADD COLUMN provider_instance_display_name TEXT;
ALTER TABLE capacity_pool_candidates ADD COLUMN provider_instance_vcpu_count INTEGER;
ALTER TABLE capacity_pool_candidates ADD COLUMN provider_instance_memory_mb INTEGER;
ALTER TABLE capacity_pool_candidates ADD COLUMN provider_instance_disk_gb INTEGER;
ALTER TABLE capacity_pool_candidates ADD COLUMN provider_instance_price_display TEXT;
ALTER TABLE capacity_pool_candidates ADD COLUMN provider_instance_price_currency TEXT;
ALTER TABLE capacity_pool_candidates ADD COLUMN provider_instance_price_monthly_cents INTEGER;
ALTER TABLE capacity_pool_candidates ADD COLUMN provider_instance_price_hourly_micros INTEGER;
ALTER TABLE capacity_pool_candidates ADD COLUMN provider_instance_catalog_source TEXT CHECK (provider_instance_catalog_source IS NULL OR provider_instance_catalog_source IN ('api', 'static'));
ALTER TABLE capacity_pool_candidates ADD COLUMN provider_instance_catalog_last_seen_at TEXT;

ALTER TABLE tasks ADD COLUMN provider_instance_type TEXT;
ALTER TABLE tasks ADD COLUMN provider_instance_vcpu_count INTEGER;
ALTER TABLE tasks ADD COLUMN provider_instance_memory_mb INTEGER;
ALTER TABLE tasks ADD COLUMN provider_instance_disk_gb INTEGER;
ALTER TABLE tasks ADD COLUMN provider_instance_price_display TEXT;
ALTER TABLE tasks ADD COLUMN provider_instance_price_currency TEXT;
ALTER TABLE tasks ADD COLUMN provider_instance_price_monthly_cents INTEGER;
ALTER TABLE tasks ADD COLUMN provider_instance_price_hourly_micros INTEGER;

ALTER TABLE nodes ADD COLUMN provider_instance_type TEXT;
ALTER TABLE nodes ADD COLUMN provider_instance_vcpu_count INTEGER;
ALTER TABLE nodes ADD COLUMN provider_instance_memory_mb INTEGER;
ALTER TABLE nodes ADD COLUMN provider_instance_disk_gb INTEGER;
ALTER TABLE nodes ADD COLUMN provider_instance_price_display TEXT;
ALTER TABLE nodes ADD COLUMN provider_instance_price_currency TEXT;
ALTER TABLE nodes ADD COLUMN provider_instance_price_monthly_cents INTEGER;
ALTER TABLE nodes ADD COLUMN provider_instance_price_hourly_micros INTEGER;

ALTER TABLE workspaces ADD COLUMN provider_instance_type TEXT;
ALTER TABLE workspaces ADD COLUMN provider_instance_vcpu_count INTEGER;
ALTER TABLE workspaces ADD COLUMN provider_instance_memory_mb INTEGER;
ALTER TABLE workspaces ADD COLUMN provider_instance_disk_gb INTEGER;
ALTER TABLE workspaces ADD COLUMN provider_instance_price_display TEXT;
ALTER TABLE workspaces ADD COLUMN provider_instance_price_currency TEXT;
ALTER TABLE workspaces ADD COLUMN provider_instance_price_monthly_cents INTEGER;
ALTER TABLE workspaces ADD COLUMN provider_instance_price_hourly_micros INTEGER;
