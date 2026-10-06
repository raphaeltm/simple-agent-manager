-- Add project-layer modern workload requirements without rebuilding the projects table.
-- `projects` is a foreign-key parent for many child tables, so this must remain additive.
ALTER TABLE projects ADD COLUMN resource_requirements_json TEXT;
