-- Insights slice I (`project_insights` method `phases`, idea 01M7HTS38KX2G78JD0ESAGMKKH): phase
-- durations are sampled per (operation, phase), from successful rows only, newest first
-- (`phaseDurationStats` in packages/operations/src/insights-phase-timings.ts):
--   WHERE project_id = ? AND skill_id = ? AND operation = ? AND phase = ? AND outcome = 'success'
--     AND created_at >= ? ORDER BY created_at DESC LIMIT ?
-- With every filter in the key, each pair's sample is one index range that stops at its LIMIT, so
-- a read examines about (pairs x sample) entries however much history is retained. The
-- (operation, phase) pairs themselves are listed by seeking this index pair by pair.
--
-- These replace the 0250 (project_id, skill|profile, phase, created_at) indexes, whose only reader
-- was that query: they lacked operation and outcome, so a rare operation or a run of failed
-- phases made the read walk a phase's whole history. Indexes only; no table is changed (rule 31).
-- Numbered 0260 to stay clear of open PRs using 0257 and 0259.
CREATE INDEX IF NOT EXISTS idx_lifecycle_phase_timings_skill_pair
  ON lifecycle_phase_timings (project_id, skill_id, operation, phase, outcome, created_at)
  WHERE skill_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_lifecycle_phase_timings_profile_pair
  ON lifecycle_phase_timings (project_id, agent_profile_id, operation, phase, outcome, created_at)
  WHERE agent_profile_id IS NOT NULL;
DROP INDEX IF EXISTS idx_lifecycle_phase_timings_skill_phase;
DROP INDEX IF EXISTS idx_lifecycle_phase_timings_profile_phase;
