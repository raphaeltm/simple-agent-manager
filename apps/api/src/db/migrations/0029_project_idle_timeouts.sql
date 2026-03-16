-- Add configurable idle timeout settings to projects
ALTER TABLE projects ADD COLUMN workspace_idle_timeout_ms INTEGER;
ALTER TABLE projects ADD COLUMN node_idle_timeout_ms INTEGER;
