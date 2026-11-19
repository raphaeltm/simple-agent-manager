-- The Run receipt (Insights slice R, `packages/operations/src/insights-receipt-reads.ts`) compares a
-- run's machine wait and setup with recent runs of the same skill, or else the same profile:
--   WHERE project_id = ? AND skill_id = ? AND created_at >= ? ORDER BY created_at DESC LIMIT ?
-- Without these indexes the only usable prefix is (project_id, created_at), so a rarely used
-- skill made every receipt walk the project's whole task window to find a handful of rows.
--
-- Additive only: new indexes on an existing table. Numbered 0252 to stay clear of 0250 (Insights
-- slice T, lifecycle_phase_timings) and 0251 (slice F, pull_request_heads).
CREATE INDEX IF NOT EXISTS idx_tasks_project_skill_created
  ON tasks (project_id, skill_id, created_at);
CREATE INDEX IF NOT EXISTS idx_tasks_project_profile_created
  ON tasks (project_id, agent_profile_hint, created_at);
