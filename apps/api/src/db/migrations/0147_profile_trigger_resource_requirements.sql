-- Preserve modern workload requirements on profile and trigger configuration layers.
ALTER TABLE agent_profiles ADD COLUMN resource_requirements_json TEXT;
ALTER TABLE triggers ADD COLUMN resource_requirements_json TEXT;
