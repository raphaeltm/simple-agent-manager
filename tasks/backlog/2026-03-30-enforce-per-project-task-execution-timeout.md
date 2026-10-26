# Enforce Per-Project Task Execution Timeout

> **Reconciliation 2026-10-26:** Still open; pointers moved. #2317 (`11d4cc80b`) and #2318
> (`7164053b4`) shifted `apps/api/src/scheduled/stuck-tasks.ts`: the sweep reads only the env value
> at `:1104`, and the Clef stall-kill paths are now `:1378-1394` and `:1447-1467`. The per-project
> value is still never read.

> **Reconciliation 2026-10-12:** Premise update. Since #2232 (`f7e68a284`),
> `TASK_RUN_MAX_EXECUTION_MS` gates a kill path again: past it, a live `in_progress` task is failed
> when the Clef classifier judges its turn stalled (quiet at least 60 min, confidence at least 0.8;
> `apps/api/src/scheduled/stuck-tasks.ts:1347-1363,1416-1436`, defaults in
> `packages/shared/src/constants/ai-services.ts:29,32`). A live turn the classifier does not call
> stalled is still kept until `TASK_RUN_ABSOLUTE_CEILING_MS`, so the 30-minute criterion still needs
> its own kill path. Still open: the sweep reads only the env value (`stuck-tasks.ts:1098`), never
> the project's.

> **Reconciliation 2026-10-05:** The premise needs correcting. `TASK_RUN_MAX_EXECUTION_MS` has not killed a live task since #1567; #2222 documents this at `apps/api/src/scheduled/stuck-task-live-runtime.ts:17-18`. The only hard stop is `TASK_RUN_ABSOLUTE_CEILING_MS` (24h, `packages/shared/src/constants/task-execution.ts:26`). Option A would therefore only move the recovery check: the "terminated after 30 minutes" criterion needs its own kill path (Option B, or a per-project absolute ceiling). The per-project value is still not read by the stuck-task sweep or TaskRunner (`apps/api/src/scheduled/stuck-tasks.ts:1113` reads env only).

## Problem Statement

The `taskExecutionTimeoutMs` per-project scaling parameter is stored in the projects table, collected via the Settings UI, and passed through `TaskRunConfig.projectScaling` — but it is never enforced at runtime. The stuck-tasks cron (`apps/api/src/scheduled/stuck-tasks.ts`) only reads the platform-wide `TASK_RUN_MAX_EXECUTION_MS` env var.

A user who sets a shorter timeout (e.g., 30 minutes instead of 4 hours) will see it saved, but tasks will still run for the full platform-wide duration.

Discovered during constitution review of PR `sam/task-per-project-scaling-01kmz5`.

## Implementation Options

### Option A: Store resolved timeout on each task row
1. Add `maxExecutionMs` INTEGER column to tasks table
2. At task-submit time, resolve via `resolveProjectScalingConfig(project.taskExecutionTimeoutMs, env.TASK_RUN_MAX_EXECUTION_MS, DEFAULT_TASK_EXECUTION_TIMEOUT_MS)`
3. In stuck-tasks cron, read per-task `maxExecutionMs` instead of platform-wide env var

### Option B: Enforce in TaskRunner DO alarm
1. TaskRunner DO already has `state.config.projectScaling?.taskExecutionTimeoutMs`
2. Add a max-execution alarm in the DO that checks elapsed time against the resolved timeout
3. Fail the task if exceeded

## Acceptance Criteria

- [ ] Per-project `taskExecutionTimeoutMs` is enforced at runtime
- [ ] A task with a 30-minute project timeout is terminated after 30 minutes
- [ ] Platform-wide default is used when project value is null
- [ ] Test verifies enforcement
