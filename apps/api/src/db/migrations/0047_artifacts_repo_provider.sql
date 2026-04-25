-- Add repo_provider and artifacts_repo_id columns for Artifacts-backed projects.
--
-- SAFE VERSION: Uses ALTER TABLE ADD COLUMN instead of table recreation.
--
-- The original version of this migration used DROP TABLE to recreate the
-- projects table (to make installation_id nullable). The DROP TABLE triggered
-- ON DELETE CASCADE on every child table (triggers, tasks, agent_profiles,
-- deployment_credentials, etc.) and destroyed all data in production.
--
-- See: docs/notes/2026-04-25-migration-cascade-data-loss-postmortem.md
--
-- installation_id remains NOT NULL. Artifacts-backed projects use the
-- sentinel installation row (system_anonymous_trials_installation) from
-- migration 0045, same as trial projects.

-- New columns (safe — ALTER TABLE ADD COLUMN does not touch existing data)
ALTER TABLE projects ADD COLUMN repo_provider TEXT NOT NULL DEFAULT 'github';
ALTER TABLE projects ADD COLUMN artifacts_repo_id TEXT;

-- Uniqueness indexes for Artifacts projects
CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_user_artifacts_repo
  ON projects(user_id, artifacts_repo_id) WHERE artifacts_repo_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_user_artifacts_repository
  ON projects(user_id, repository) WHERE repo_provider = 'artifacts';
