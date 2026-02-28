# Implementation Plan: TDF-5 Workspace Lifecycle -- Event-Driven Readiness

**Branch**: `tdf-5/workspace-lifecycle-events` | **Date**: 2026-02-28 | **Spec**: `specs/tdf-5-workspace-lifecycle/spec.md`

## Summary

Remove the D1 polling fallback from the TaskRunner DO's `handleWorkspaceReady()` step and make the workspace-ready callback inline (not `waitUntil()`). This is a focused, surgical change that tightens the workspace lifecycle without modifying the step machine or VM agent.

## Technical Context

**Language/Version**: TypeScript 5.x (Cloudflare Workers)
**Primary Dependencies**: Hono (API), Drizzle ORM (D1), Cloudflare Workers SDK (Durable Objects)
**Storage**: D1 (workspace metadata) + DO storage (pipeline state)
**Testing**: Vitest (source contract tests)
**Target Platform**: Cloudflare Workers
**Constraints**: DO single-threaded execution guarantee; callback-driven advancement only

## Constitution Check

- [x] **Principle XI (No Hardcoded Values)**: All timeouts remain configurable via env vars. No new hardcoded values introduced.
- [x] **Principle II (Infrastructure Stability)**: Comprehensive test suite for all workspace lifecycle scenarios.

## Project Structure

### Source Code Changes

```text
apps/api/
  src/
    durable-objects/
      task-runner.ts           # MODIFY: remove D1 polling from handleWorkspaceReady()
    routes/
      workspaces.ts            # MODIFY: inline DO notification (remove waitUntil)
  tests/
    unit/
      workspace-lifecycle.test.ts  # NEW: comprehensive workspace lifecycle tests
```

### Documentation

```text
specs/tdf-5-workspace-lifecycle/
  spec.md        (this spec)
  plan.md        (this file)
  data-model.md
  tasks.md
```

## Design Decisions

### Remove D1 Polling (Not Just Reduce Frequency)

With TDF-4's reliable callback retries, the D1 polling path is truly unnecessary. Keeping it would mean maintaining two advancement paths, making the code harder to reason about and test. The timeout alarm remains as the safety net.

### Inline Callback Notification (Not waitUntil)

Moving from `waitUntil()` to inline `await` for the DO notification:

- **Pro**: Eliminates the `waitUntil()` death window entirely. If the DO notification fails, the VM agent gets an error response and retries.
- **Pro**: Simpler error handling -- one request, one outcome.
- **Con**: Slightly increases the `/ready` endpoint latency (by the DO RPC roundtrip, ~10-50ms).
- **Decision**: The latency increase is negligible and the reliability improvement is significant.

### Timeout Alarm Strategy

Instead of polling D1 every 5s, the DO schedules a single alarm at the remaining timeout boundary. When the alarm fires:

1. If `workspaceReadyReceived` is true (callback arrived between alarm scheduling and firing), advance immediately.
2. If timed out, fail the task.
3. If neither, re-schedule for the remaining time.

This eliminates unnecessary alarm churn while maintaining the timeout safety net.

## Complexity Tracking

No constitution violations. The changes reduce complexity by removing a code path (D1 polling) rather than adding one.
