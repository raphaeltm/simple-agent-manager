-- Additive runtime allocation metadata for provider-native plans and observed hardware.
-- Planned provider_instance_* fields are candidate/plan metadata. observed_* fields
-- are written only from provider create/list responses and remain separate from
-- compatibility estimates.

ALTER TABLE tasks ADD COLUMN provider_instance_boot_disk_size_gb INTEGER;
ALTER TABLE tasks ADD COLUMN provider_instance_image TEXT;
ALTER TABLE tasks ADD COLUMN provider_instance_architecture TEXT;

ALTER TABLE capacity_pool_candidates ADD COLUMN provider_instance_boot_disk_size_gb INTEGER;
ALTER TABLE capacity_pool_candidates ADD COLUMN provider_instance_image TEXT;
ALTER TABLE capacity_pool_candidates ADD COLUMN provider_instance_architecture TEXT;

ALTER TABLE projects ADD COLUMN resource_requirements_json TEXT;

ALTER TABLE nodes ADD COLUMN provider_instance_boot_disk_size_gb INTEGER;
ALTER TABLE nodes ADD COLUMN provider_instance_image TEXT;
ALTER TABLE nodes ADD COLUMN provider_instance_architecture TEXT;
ALTER TABLE nodes ADD COLUMN observed_provider_instance_type TEXT;
ALTER TABLE nodes ADD COLUMN observed_provider_instance_vcpu_count INTEGER;
ALTER TABLE nodes ADD COLUMN observed_provider_instance_memory_mb INTEGER;
ALTER TABLE nodes ADD COLUMN observed_provider_instance_disk_gb INTEGER;
ALTER TABLE nodes ADD COLUMN observed_hardware_json TEXT;
ALTER TABLE nodes ADD COLUMN observed_hardware_source TEXT;

ALTER TABLE workspaces ADD COLUMN provider_instance_boot_disk_size_gb INTEGER;
ALTER TABLE workspaces ADD COLUMN provider_instance_image TEXT;
ALTER TABLE workspaces ADD COLUMN provider_instance_architecture TEXT;

ALTER TABLE compute_usage ADD COLUMN provider_instance_boot_disk_size_gb INTEGER;
ALTER TABLE compute_usage ADD COLUMN provider_instance_image TEXT;
ALTER TABLE compute_usage ADD COLUMN provider_instance_architecture TEXT;
ALTER TABLE compute_usage ADD COLUMN observed_provider_instance_type TEXT;
ALTER TABLE compute_usage ADD COLUMN observed_provider_instance_vcpu_count INTEGER;
ALTER TABLE compute_usage ADD COLUMN observed_provider_instance_memory_mb INTEGER;
ALTER TABLE compute_usage ADD COLUMN observed_provider_instance_disk_gb INTEGER;
ALTER TABLE compute_usage ADD COLUMN observed_hardware_json TEXT;
ALTER TABLE compute_usage ADD COLUMN observed_hardware_source TEXT;
