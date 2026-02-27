# Implementation Plan: TDF-2 Orchestration Engine

**Branch**: `tdf-2-orchestration-engine` | **Date**: 2026-02-27 | **Spec**: `specs/tdf-2-orchestration-engine/spec.md`

## Summary

Migrate the task orchestration pipeline from `waitUntil(executeTaskRun())` to a TaskRunner Durable Object with alarm-driven step execution. Each orchestration step becomes an independent, idempotent alarm callback. Workspace readiness is advanced via direct DO callbacks instead of D1 polling.

## Technical Context

**Language/Version**: TypeScript 5.x (Cloudflare Workers)
**Primary Dependencies**: Hono (API), Drizzle ORM (D1), Cloudflare Workers SDK (Durable Objects)
**Storage**: D1 (task metadata) + DO storage (pipeline state)
**Testing**: Vitest + Miniflare (DO testing)
**Target Platform**: Cloudflare Workers
**Constraints**: DO alarm resolution ~10ms; DO storage is key-value; single-threaded execution per DO

## Constitution Check

- [x] **Principle II (Infrastructure Stability)**: Comprehensive test suite required — unit, integration, and chaos tests for all step handlers.
- [x] **Principle XI (No Hardcoded Values)**: All timeouts, retry counts, and backoff parameters configurable via env vars with defaults exported from `@simple-agent-manager/shared`.
- [x] **Principle XII (Zero-to-Production)**: New DO binding must be in wrangler.toml, Pulumi stack, and self-hosting docs. Migration tag `v4` for DO namespace provisioning.

## Project Structure

### Source Code

```text
apps/api/
├── src/
│   ├── durable-objects/
│   │   ├── task-runner.ts           # NEW: TaskRunner DO
│   │   ├── node-lifecycle.ts        # existing
│   │   └── project-data.ts          # existing
│   ├── services/
│   │   ├── task-runner.ts           # MODIFY: remove executeTaskRun, keep cleanup
│   │   └── task-runner-do.ts        # NEW: helper to wake/advance DO
│   ├── routes/
│   │   ├── task-submit.ts           # MODIFY: wake DO instead of waitUntil
│   │   ├── task-runs.ts             # MODIFY: wake DO instead of waitUntil
│   │   ├── workspaces.ts            # MODIFY: ready callback pokes DO
│   │   └── tasks.ts                 # MODIFY: callback handler coordination
│   ├── scheduled/
│   │   └── stuck-tasks.ts           # MODIFY: skip DO-managed tasks
│   └── index.ts                     # MODIFY: export TaskRunner, add binding
├── tests/
│   ├── unit/
│   │   ├── durable-objects/
│   │   │   └── task-runner.test.ts  # NEW: step handler unit tests
│   │   └── services/
│   │       └── task-runner-do.test.ts # NEW: DO helper tests
│   └── integration/
│       └── task-runner-do.test.ts   # NEW: full pipeline integration
packages/shared/src/
└── types.ts                         # MODIFY: add defaults for new env vars
```

### Documentation

```text
specs/tdf-2-orchestration-engine/
├── spec.md
├── plan.md (this file)
├── data-model.md
└── tasks.md
```

## Design Decisions

### DO-per-task (not shared DO)

Each task gets its own TaskRunner DO instance (keyed by `taskId`). This provides:
- Natural isolation — one task's failure doesn't affect others
- Simple concurrency model — DO is single-threaded per instance
- Clean lifecycle — DO can be garbage collected when task completes
- Scales naturally with task count

Trade-off: More DO instances, but Cloudflare handles this efficiently (millions of DOs per namespace).

### Single Alarm with Step Dispatch

One alarm handler dispatches based on `currentStep`. Simpler than managing multiple alarm types and matches the existing NodeLifecycle pattern.

### D1 Remains Source of Truth for Task Status

The DO drives transitions but D1 `tasks` table remains the canonical store for `status` and `executionStep`. The frontend polls D1, and the stuck-task cron queries D1. The DO's own storage only tracks pipeline control state (current step, retry count, accumulated results).

### Workspace-Ready Callback Instead of Polling

The existing `/workspaces/{id}/ready` route handler (in `workspaces.ts`) will be extended to look up the associated task and poke the TaskRunner DO. This eliminates the `waitForWorkspaceReady()` polling loop entirely.

### Gradual Migration

- New tasks use DO path (task-submit.ts and task-runs.ts wake DO)
- Old `executeTaskRun()` is kept but no longer called from routes
- Stuck-task cron still runs as safety net for any edge cases
- Old code can be fully removed in a follow-up PR after monitoring confirms reliability

## Complexity Tracking

No constitution violations. The new DO follows existing patterns (NodeLifecycle) and adds no unnecessary abstractions.
