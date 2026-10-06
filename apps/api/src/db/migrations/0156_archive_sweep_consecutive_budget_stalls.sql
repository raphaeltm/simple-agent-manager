-- A sweep that migrates nothing because every candidate it can see costs more than the
-- entire daily write allowance is STUCK, not idle, and must stop reporting `succeeded`.
--
-- On 2026-09-08 the production daily write budget was lowered to 100000 through a GitHub
-- Environment override while `PROJECT_DATA_ARCHIVE_SWEEP_MESSAGE_BUDGET` stayed at the
-- checked-in 5000. Largest-first selection then picked the same 4994-message session every
-- hour for four days, each time estimating ~160,808 writes against a 100,000 allowance and
-- refusing before touching D1. `last_status` said `succeeded`, `last_skip_reason` and
-- `last_error` were NULL, and `run_count` climbed past 226 while the root Durable Object
-- went from 94% to 96.7% of its storage ceiling. Nothing in this row said anything was wrong.
--
-- Counting CONSECUTIVE stalls (rather than alerting on the first) keeps the signal specific:
-- an occasional unaffordable candidate is expected, because the selection ceiling is derived
-- from an assumed per-session overhead and the sweep simply descends to the next candidate.
-- Only a run of ticks that journal nothing at all is the deadlock.
--
-- ALTER TABLE ADD COLUMN, never a table recreation: this table is read by the archive
-- coordinator and the admin rollout endpoints, and `.claude/rules/31` forbids recreating a
-- table to change its shape.
ALTER TABLE project_data_archive_global_sweep_cadence
  ADD COLUMN consecutive_budget_stalls INTEGER NOT NULL DEFAULT 0;

-- No backfill: 0 is the correct starting value for every existing row. A currently-stalled
-- installation re-derives its count from the next sweep onward, which is the intended
-- behaviour — the counter measures consecutive stalls observed under the new logic, not
-- history it cannot reconstruct.
