ALTER TABLE compute_usage ADD COLUMN provider_instance_type TEXT;
ALTER TABLE compute_usage ADD COLUMN provider_instance_vcpu_count INTEGER;
ALTER TABLE compute_usage ADD COLUMN provider_instance_memory_mb INTEGER;
ALTER TABLE compute_usage ADD COLUMN provider_instance_disk_gb INTEGER;
ALTER TABLE compute_usage ADD COLUMN provider_instance_price_display TEXT;
ALTER TABLE compute_usage ADD COLUMN provider_instance_price_currency TEXT;
ALTER TABLE compute_usage ADD COLUMN provider_instance_price_monthly_cents INTEGER;
ALTER TABLE compute_usage ADD COLUMN provider_instance_price_hourly_micros INTEGER;
