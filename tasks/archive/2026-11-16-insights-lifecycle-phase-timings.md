# Insights slice T: store lifecycle phase timings

Task 01M7HTVBK5AMXJZNHF16YB8ZT7. Build spec: idea 01M7HTS38KX2G78JD0ESAGMKKH (slice T).
Coordinator: task 01M7H0X3PMHK6WT29B1BSSCGWW, channel `feature.insights`.

## Problem

The VM agent reports phase timings for provision, workspace create, sleep and wake, and the
TaskRunner times its own steps. `recordLifecycleTimings()` (`apps/api/src/services/lifecycle-timings.ts`)
and `recordRunnerPhase()` (`apps/api/src/durable-objects/task-runner/phase-timings.ts`) only call
`log.info`, so nothing can be queried later ("setup took 2.3x this skill's usual").

## Research findings

- Callers of `recordLifecycleTimings`: node ready callback (`routes/node-lifecycle.ts`, provision,
  node only) and the workspace lifecycle-timings callback (`routes/workspaces/lifecycle-timings.ts`,
  workspace/sleep/wake; the workspace row gives project, node and chat ids).
- Callers of `recordRunnerPhase`: `task-runner/index.ts` (step error, `advanceToStep`) and
  `task-runner/in-progress-transition.ts` (two terminal `running` transitions). State carries
  taskId, projectId, workspaceId, nodeId and chatSessionId.
- `tasks.workspace_id` is written at workspace allocation (`workspace-reserved-allocation.ts`),
  before the VM agent can report workspace-create phases, so a workspace callback can find its
  task inside the INSERT statement. `tasks.skill_id` exists; `tasks.agent_profile_hint` holds a
  resolved profile id for dispatch/chat/submit paths but may hold a name on the REST create path,
  so a profile id is stored only when it names an existing `agent_profiles` row.
- Daily evaluation (`services/lifecycle-latency/daily-evaluation.ts`) already purges
  `lifecycle_state_episodes` with `purgeInBatches` (5k rows x 20 batches) and
  `lifecycleLatency.retentionDays`.
- Shared reads live in `packages/operations` and read `ctx.env.DATABASE` directly
  (`project-overview.ts`). Worker-backed tests live in `apps/api/tests/unit/operations/`.

## Design decisions

- One additive migration (0250) with nullable `project_id` in addition to the spec columns: it is
  in hand on every workspace/runner write, and makes every read project-scoped by predicate
  (rule 11). Provision rows are node-level and have no project.
- Attribution (task, skill, profile) resolved inside the INSERT by sub-selects, scoped by project:
  zero extra round trips, and the skill/profile index is usable without a join at read time.
- Writes are one `DATABASE.batch()` per callback (one round trip) and never throw: a failed write
  logs `session_lifecycle.timings_store_failed` and the callback continues.
- Runner rows use operations `runner_start` / `runner_wake` so they never mix with the VM agent's
  `wake` phases.

## Checklist

- [x] Migration `0250_lifecycle_phase_timings.sql` + drizzle schema in `packages/worker-core`
- [x] `recordLifecycleTimings` stores rows (batch insert), keeps log line and bounded phases
- [x] Node ready + workspace callback routes await the store with their ids
- [x] `recordRunnerPhase` stores a row, all four call sites await it
- [x] Daily evaluation purges `lifecycle_phase_timings` with the same retention and batching
- [x] `packages/operations/src/insights-phase-timings.ts`: `phaseDurationStats`, `listPhaseTimings`
- [x] Tests: route insert path, runner insert, purge, read on real SQL with foreign-project attack
- [x] Docs: lifecycle latency / observability doc mentions the stored table

## Acceptance criteria

- A workspace lifecycle-timings callback writes one row per bounded phase with project, workspace,
  node, chat, task, skill and profile ids.
- A node ready callback writes provision rows with node id only.
- A runner step transition writes one row.
- Store failures never fail the callback or the runner step.
- The daily run deletes rows older than `lifecycleLatency.retentionDays`.
- Reads return median/p90 per phase for a skill or profile in one project, and phases for a task or
  workspace; a foreign project's rows never appear.
