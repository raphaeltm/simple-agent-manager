-- Insights slice T (idea 01M7HTS38KX2G78JD0ESAGMKKH): store the lifecycle phase timings the VM
-- agent and the TaskRunner already report, instead of only logging them.
--   Writers: recordLifecycleTimings() (apps/api/src/services/lifecycle-timings.ts) and
--            recordRunnerPhase() (apps/api/src/durable-objects/task-runner/phase-timings.ts).
--   Reads:   packages/operations/src/insights-phase-timings.ts.
--   Purge:   runLifecycleLatencyDailyEvaluation(), `lifecycleLatency.retentionDays`.
--
-- No foreign keys: rows are bounded telemetry purged by age, and must never block or cascade a
-- workspace, node, task or profile delete. created_at is epoch milliseconds.
--
-- Additive only (rule 31): a new table and its indexes. Numbered 0250 to stay clear of 0247/0248
-- (open PRs #2780, #2781) and 0249 (main).
CREATE TABLE IF NOT EXISTS lifecycle_phase_timings (
  -- Plain rowid key: no AUTOINCREMENT, so an insert does not also write sqlite_sequence.
  id INTEGER PRIMARY KEY,
  operation TEXT NOT NULL,
  phase TEXT NOT NULL,
  outcome TEXT NOT NULL,
  duration_ms INTEGER NOT NULL,
  project_id TEXT,
  workspace_id TEXT,
  node_id TEXT,
  chat_session_id TEXT,
  task_id TEXT,
  skill_id TEXT,
  agent_profile_id TEXT,
  created_at INTEGER NOT NULL
);

-- Recent rows for one workspace or one task (run receipt).
CREATE INDEX IF NOT EXISTS idx_lifecycle_phase_timings_workspace
  ON lifecycle_phase_timings (workspace_id, created_at)
  WHERE workspace_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_lifecycle_phase_timings_task
  ON lifecycle_phase_timings (task_id, created_at)
  WHERE task_id IS NOT NULL;
-- Phase durations for a skill or a profile over a window, always within one project.
CREATE INDEX IF NOT EXISTS idx_lifecycle_phase_timings_skill_phase
  ON lifecycle_phase_timings (project_id, skill_id, phase, created_at)
  WHERE skill_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_lifecycle_phase_timings_profile_phase
  ON lifecycle_phase_timings (project_id, agent_profile_id, phase, created_at)
  WHERE agent_profile_id IS NOT NULL;
-- Age purge in the daily lifecycle latency evaluation.
CREATE INDEX IF NOT EXISTS idx_lifecycle_phase_timings_created
  ON lifecycle_phase_timings (created_at);
