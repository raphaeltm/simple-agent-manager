# Quickstart: Task-Driven Chat Architecture & Autonomous Workspace Execution

**Date**: 2026-02-24
**Spec**: [spec.md](./spec.md) | **Plan**: [plan.md](./plan.md) | **Data Model**: [data-model.md](./data-model.md)

This guide helps implementers get oriented quickly. Read this before diving into code.

---

## What This Feature Does

Currently, the browser is responsible for persisting chat messages to the ProjectData DO. This breaks when no browser is open (async task execution). This feature:

1. **Moves message persistence to the VM agent** — messages are saved regardless of whether a browser is viewing them
2. **Connects tasks to chat sessions** — submit a task, it auto-provisions a workspace, executes, and persists full chat history
3. **Adds warm node pooling** — nodes stay alive 30 minutes after use for fast reuse
4. **Delivers a chat-first project UI** — with task kanban board and split-button task submission

---

## Architecture Overview

```
User submits task ──> API creates chat session + workspace
                           │
                           v
                    Node provisioned (or warm node claimed)
                           │
                           v
                    VM Agent starts ACP session
                           │
                           v
              ┌────────────┴────────────┐
              │                         │
    [Direct ACP WebSocket]    [SQLite Outbox → HTTP → DO]
    (browser in workspace)    (always, regardless of viewer)
              │                         │
              v                         v
    Real-time streaming         ProjectData DO persists
    to connected browser        + WebSocket broadcast to
                                project page viewers
```

---

## Implementation Phases

### Phase 1: VM Agent Message Persistence (Foundation)

**Goal**: All workspace chat messages persist to DO via the VM agent, not the browser.

**Key changes**:
1. New Go package: `packages/vm-agent/internal/messagereport/`
   - Follow the `errorreport.Reporter` pattern but add SQLite outbox + retry
   - Hook into `sessionHostClient.SessionUpdate()` in `session_host.go`
2. New API endpoint: `POST /api/workspaces/:workspaceId/messages`
   - Auth via existing callback JWT
   - Batch persistence to ProjectData DO
3. Cloud-init extension: pass `PROJECT_ID` and `CHAT_SESSION_ID` as env vars
4. Chat session created during workspace/task creation
5. Remove browser-side persistence in `chat-persistence.ts`

**Start here**: Read `packages/vm-agent/internal/errorreport/reporter.go` — the message reporter follows this exact pattern with SQLite persistence and retry added on top.

### Phase 2: Enhanced Task Runner + Node Pooling

**Goal**: Auto-cleanup on completion, warm node reuse, project-level VM size defaults.

**Key changes**:
1. New DO: `NodeLifecycle` for warm timeout + atomic claiming
2. Enhanced `executeTaskRun()` completion flow: destroy workspace, mark node warm
3. Enhanced `selectNodeForTaskRun()`: try warm nodes first via DO `tryClaim()`
4. Cron trigger for reconciliation sweep (safety net)
5. D1 migration: `projects.default_vm_size`, `nodes.warm_since`

**Start here**: Read `apps/api/src/services/task-runner.ts` — specifically `executeTaskRun()` and `cleanupTaskRun()`.

### Phase 3: Project-Level Chat + Task UI

**Goal**: Chat-first project view, task kanban, split-button submission.

**Key changes**:
1. `ProjectChat.tsx` — session sidebar + message viewer + DO WebSocket
2. `TaskKanbanBoard.tsx` — columns per primary status, transient indicators
3. `TaskSubmitForm.tsx` — split button: "Run Now" (primary) / "Save to Backlog" (dropdown)
4. Route changes: default project view is chat, swappable to kanban

**Start here**: Read `apps/web/src/pages/Project.tsx` — the tab-based shell you'll modify.

---

## Key Patterns to Follow

### 1. ErrorReporter Pattern (Go)

The message reporter is modeled on `errorreport.Reporter`:
- Batched queue with periodic flush + max batch size trigger
- `stopC`/`doneC` channels for graceful shutdown
- Non-blocking: failures logged, never block operation
- Nil-safe: methods are no-ops on nil Reporter

**Add on top**: SQLite outbox, `cenkalti/backoff/v5` retry, idempotent delivery.

### 2. Callback JWT Auth (existing)

VM agent already uses callback JWT for 6+ API call categories. The message persistence endpoint reuses this:
```
Authorization: Bearer <callback-jwt>
POST /api/workspaces/:workspaceId/messages
```

### 3. DO Alarm Pattern (new)

NodeLifecycle DO uses `setAlarm()` for the warm timeout:
```typescript
await this.ctx.storage.setAlarm(Date.now() + warmTimeoutMs);
```
- Alarms survive DO eviction
- `setAlarm()` overwrites previous alarm (timeout reset)
- Single-threaded execution eliminates race conditions

### 4. Transactional Outbox Pattern (Go)

```
Message generated → INSERT into SQLite outbox → Background goroutine reads + POSTs → DELETE on success
```
- Crash-safe: messages survive SIGKILL
- Idempotent: API deduplicates via `messageId`
- Bounded: max outbox size prevents unbounded disk growth

---

## New Environment Variables

### VM Agent (Go)

| Variable | Default | Description |
|---|---|---|
| `PROJECT_ID` | — | Project context (from cloud-init) |
| `CHAT_SESSION_ID` | — | Pre-created session (from cloud-init) |
| `MSG_BATCH_MAX_WAIT_MS` | `2000` | Flush interval |
| `MSG_BATCH_MAX_SIZE` | `50` | Max messages per batch |
| `MSG_BATCH_MAX_BYTES` | `65536` | Max batch payload |
| `MSG_OUTBOX_MAX_SIZE` | `10000` | Max pending messages |
| `MSG_RETRY_INITIAL_INTERVAL_MS` | `1000` | Initial retry backoff |
| `MSG_RETRY_MAX_INTERVAL_MS` | `30000` | Max retry backoff |
| `MSG_RETRY_MAX_ELAPSED_TIME_MS` | `300000` | Max total retry time |

### Control Plane (Cloudflare Worker)

| Variable | Default | Description |
|---|---|---|
| `NODE_WARM_TIMEOUT_MS` | `1800000` | Warm node idle timeout (30 min) |
| `MAX_AUTO_NODE_LIFETIME_MS` | `14400000` | Max node lifetime (4 hr) |

---

## New Dependencies

| Package | Version | Language | License | Purpose |
|---|---|---|---|---|
| `cenkalti/backoff/v5` | v5.0.0 | Go | MIT | Exponential backoff with jitter for message retry |

No new TypeScript dependencies for Phase 1 or 2. Phase 3 may add a drag-and-drop library for kanban (evaluate `@dnd-kit/core` when implementing).

---

## Testing Strategy

### Critical Paths (>90% coverage, TDD)

1. **Message outbox**: write → flush → acknowledge → retry → shutdown
2. **NodeLifecycle DO**: markIdle → alarm → destroy; tryClaim race conditions
3. **Task runner completion**: clean completion → workspace destroy → node warm
4. **Batch endpoint**: validation, idempotency, auth

### Integration Tests

1. **VM agent → API → DO**: End-to-end message flow with Miniflare
2. **Task run lifecycle**: Submit → provision → execute → complete → cleanup
3. **Warm node reuse**: Complete task → warm → new task claims warm node

### E2E (Playwright)

1. Submit task from project page → verify chat messages appear
2. Kanban board reflects task status transitions
3. Chat session sidebar navigation

---

## Files to Read First

| Priority | File | Why |
|---|---|---|
| 1 | `packages/vm-agent/internal/errorreport/reporter.go` | Pattern template for message reporter |
| 2 | `apps/api/src/services/task-runner.ts` | Task execution flow you're enhancing |
| 3 | `apps/api/src/durable-objects/project-data.ts` | DO you're persisting messages to |
| 4 | `packages/cloud-init/src/generate.ts` | Cloud-init template you're extending |
| 5 | `apps/api/src/services/jwt.ts` | JWT auth you're reusing |
| 6 | `apps/web/src/pages/Project.tsx` | Project shell you're modifying for chat view |
| 7 | `packages/vm-agent/internal/acp/session_host.go` | ACP session host where you hook persistence |
