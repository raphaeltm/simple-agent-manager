# Enforce Per-Project Task Execution Timeout

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
