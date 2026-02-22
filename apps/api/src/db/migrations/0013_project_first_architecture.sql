-- Migration: 0013_project_first_architecture
-- Add project-first architecture columns to projects table
-- Part of spec 018: Project-First Architecture

-- Stable GitHub repository identity
ALTER TABLE projects ADD COLUMN github_repo_id INTEGER;
ALTER TABLE projects ADD COLUMN github_repo_node_id TEXT;

-- Project status (active, detached)
ALTER TABLE projects ADD COLUMN status TEXT NOT NULL DEFAULT 'active';

-- Summary data synced from per-project Durable Object
ALTER TABLE projects ADD COLUMN last_activity_at TEXT;
ALTER TABLE projects ADD COLUMN active_session_count INTEGER NOT NULL DEFAULT 0;

-- Unique constraint: one project per user per GitHub repo
-- Partial index: only enforce when github_repo_id is set (nullable for existing projects)
CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_user_github_repo_id
  ON projects(user_id, github_repo_id)
  WHERE github_repo_id IS NOT NULL;
