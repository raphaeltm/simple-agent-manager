-- Migration 0048: Missions (Phase 2 Orchestration Primitives)
--
-- Adds the missions table and extends tasks with mission_id and scheduler_state.
-- SAFE: Uses CREATE TABLE for new table and ALTER TABLE ADD COLUMN for existing table.
-- tasks is a CASCADE parent (task_dependencies, task_status_events) — never DROP TABLE.

-- ─── New missions table ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS missions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'planning',
  root_task_id TEXT,
  budget_config TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_missions_project_id ON missions(project_id);
CREATE INDEX IF NOT EXISTS idx_missions_project_status ON missions(project_id, status);
CREATE INDEX IF NOT EXISTS idx_missions_user_id ON missions(user_id);

-- ─── Extend tasks table ─────────────────────────────────────────────────────
-- mission_id: nullable FK to missions. Tasks without a mission work as before.
ALTER TABLE tasks ADD COLUMN mission_id TEXT REFERENCES missions(id) ON DELETE SET NULL;

-- scheduler_state: nullable, only meaningful for mission tasks.
ALTER TABLE tasks ADD COLUMN scheduler_state TEXT;

-- Index for mission-scoped task queries
CREATE INDEX IF NOT EXISTS idx_tasks_mission_id ON tasks(mission_id) WHERE mission_id IS NOT NULL;
