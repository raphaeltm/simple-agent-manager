-- Resource override audit defaults.
-- Additive only: stores inherited resource requirement JSON for projects,
-- agent profiles, triggers, and additional task request snapshots.

ALTER TABLE projects ADD COLUMN default_resource_requirements_json TEXT;

ALTER TABLE agent_profiles ADD COLUMN resource_requirements_json TEXT;

ALTER TABLE triggers ADD COLUMN resource_requirements_json TEXT;

ALTER TABLE tasks ADD COLUMN requested_provider TEXT;
ALTER TABLE tasks ADD COLUMN requested_provider_source TEXT;
ALTER TABLE tasks ADD COLUMN requested_vm_location TEXT;
ALTER TABLE tasks ADD COLUMN requested_vm_location_source TEXT;
ALTER TABLE tasks ADD COLUMN requested_workspace_profile TEXT;
ALTER TABLE tasks ADD COLUMN requested_workspace_profile_source TEXT;
ALTER TABLE tasks ADD COLUMN requested_task_mode TEXT;
ALTER TABLE tasks ADD COLUMN requested_task_mode_source TEXT;

