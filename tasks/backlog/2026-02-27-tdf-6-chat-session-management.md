# TDF-6: Chat Session Management — Fix Duplicate Sessions, Fallback IDs & Message Reliability

**Created**: 2026-02-27
**Priority**: High
**Classification**: `business-logic-change`, `cross-component-change`
**Dependencies**: TDF-2 (Orchestration Engine — session creation timing depends on DO model)
**Blocked by**: TDF-2
**Blocks**: TDF-8 (Frontend State Tracking)

---

## Context

The chat session system has three concrete bugs that cause broken user experiences: duplicate session creation, phantom fallback session IDs, and unreliable message persistence. These are fixable independently of the broader architectural changes, but the fixes must be coordinated with the new Durable Object orchestration model from TDF-2.

### Research References

- **Flow map**: `docs/task-delegation-flow-map.md`
  - Section "Known Weak Points" #2 — Duplicate chat session creation
  - Section "Known Weak Points" #3 — Fallback session ID
  - Section "Known Weak Points" #4 — Best-effort message persistence
  - Section "Known Weak Points" #7 — Chat session not linked to workspace at submit time
  - Section "Known Weak Points" #8 — Idle cleanup depends on chat session link
  - Section "Chat Message Flow" — message persistence path and WebSocket broadcasting
  - Section "Recommended Fixes" P2, P3 — duplicate session and fallback ID fixes
- **ProjectData DO**: `apps/api/src/durable-objects/project-data.ts` — session CRUD, message persistence, WebSocket
- **Task submit route**: `apps/api/src/routes/task-submit.ts` — first session creation (step 10)
- **Task runner**: `apps/api/src/services/task-runner.ts` — second session creation (workspace creation step)
- **Chat routes**: `apps/api/src/routes/chat.ts` — session CRUD + WebSocket streaming
- **Project data service**: `apps/api/src/services/project-data.ts` — typed wrapper for DO RPCs
- **Message reporter (Go)**: `packages/vm-agent/internal/messagereport/` — batch message persistence from VM

---

## Problem Statement

### Bug 1: Duplicate Chat Session Creation

Two code paths create sessions for the same task:

1. **`task-submit.ts` (step 10)**: Creates a session immediately at task submission. This session receives the user's initial message.
2. **`task-runner.ts` (workspace creation step)**: Creates ANOTHER session when the workspace is created. This session gets linked to the workspace.

**Result**: Two sessions exist for one task. The first has the user's message but no workspace link. The second has the workspace link but no messages. Message persistence from the VM goes to the workspace-linked session, so the user's initial message and the agent's responses end up in different sessions.

### Bug 2: Fallback Session ID

If the session creation in `task-submit.ts` fails (DO unavailable, timeout), the code generates a fake ID: `sess-fallback-{taskId}`. This ID is returned to the frontend and:
- Doesn't correspond to any real session in the ProjectData DO
- WebSocket subscription for this ID receives no events
- Any attempt to persist messages to this session silently fails
- The user sees an empty chat while the agent is working

### Bug 3: Workspace-Session Linking Gap

At submission time, the workspace doesn't exist yet. The session is created with `workspaceId = null`. The workspace is only created later by the task runner. If the runner links the workspace to the session, great. But if the runner fails before linking (e.g., `waitUntil` death), the session has no workspace. This means:
- Idle cleanup can't find the session (it looks up sessions via `workspace.chatSessionId`)
- The workspace stays running indefinitely until the stuck-task cron catches it
- Message persistence from the VM can't find the right session

### Bug 4: Best-Effort Message Persistence

All message writes are fire-and-forget:
- The initial user message in `task-submit.ts` — caught and logged on failure
- Batch messages from the VM via `/messages/batch` — HTTP failures silently dropped
- The user can see an empty chat while the agent is actively working

---

## Scope

### In Scope

- Fix duplicate session creation: single session per task, created once
- Eliminate fallback session ID: if session creation fails, fail the task submission
- Fix workspace-session linking: session is linked to workspace when workspace is created, regardless of session creation timing
- Improve message persistence reliability: at-least-once delivery with acknowledgment
- Add tests for session lifecycle (create, link, messages, idle, stop)
- Add tests for message deduplication (same messageId sent twice)
- Add tests for WebSocket broadcasting (session events reach subscribers)

### Out of Scope

- Redesigning the ProjectData DO (it works fine internally)
- The orchestration engine (TDF-2) — but coordinate with it on session creation timing
- Frontend WebSocket subscription logic (TDF-8)
- Idle cleanup timer internals (already work correctly when the session IS linked)

---

## Acceptance Criteria

- [ ] One task = one chat session. No duplicate sessions created under any code path.
- [ ] Session creation is required, not best-effort. If it fails, task submission fails with a clear error.
- [ ] No fallback session IDs anywhere in the codebase. `sess-fallback-*` pattern is removed.
- [ ] Session is linked to workspace when workspace is created (via TaskRunner DO, post-TDF-2)
- [ ] If workspace linking fails, the session still exists and receives messages (graceful degradation)
- [ ] Message persistence from VM has at-least-once delivery: retry on failure, deduplicate on success
- [ ] Initial user message is persisted reliably (not best-effort)
- [ ] WebSocket subscribers receive `message.new` events for all persisted messages
- [ ] Idle cleanup works correctly: session linked to workspace → timer fires → cleanup runs
- [ ] Unit tests: session creation, linking, message persistence, deduplication
- [ ] Integration tests: full session lifecycle from creation to stop
- [ ] All tests pass in CI

---

## Fix Strategy

### Fix 1: Single Session Creation Point

**Before**: Session created in both `task-submit.ts` and `task-runner.ts`.
**After**: Session created ONLY in `task-submit.ts`. The task runner receives the session ID and links it to the workspace when the workspace is created.

```
task-submit.ts:
  1. Create session in ProjectData DO (REQUIRED, not best-effort)
  2. Persist initial user message (REQUIRED)
  3. Return sessionId to frontend
  4. Pass sessionId to task runner (via task record or direct)

task-runner.ts (or TaskRunner DO post-TDF-2):
  1. When workspace is created, link session to workspace
     (projectDataService.linkSessionToWorkspace(sessionId, workspaceId))
  2. Do NOT create a new session
```

### Fix 2: No Fallback Session ID

**Before**: If session creation fails, generate `sess-fallback-{taskId}`.
**After**: If session creation fails, return 500 to the frontend. Task is not created. User sees clear error.

### Fix 3: Reliable Message Persistence

**Before**: Fire-and-forget HTTP POSTs.
**After**: VM agent message reporter uses retry with backoff (coordinated with TDF-4 contract). Control plane `/messages/batch` endpoint returns acknowledgment per message. Unacknowledged messages are retried.

---

## Testing Requirements

### Unit Tests

| Test Category | What to Test |
|--------------|-------------|
| Session creation | Single session created per task, correct initial state |
| Session creation failure | Task submission fails with clear error, no fallback ID |
| Workspace linking | Session.workspaceId updated when workspace created |
| Message persistence | Messages stored, message_count incremented, topic captured |
| Message deduplication | Same messageId sent twice, only one stored |
| Idle timer | agentCompletedAt set → timer scheduled → cleanup fires |
| Session stop | Status transitions to stopped, no more messages accepted |

### Integration Tests (Miniflare + ProjectData DO)

| Test Category | What to Test |
|--------------|-------------|
| Full session lifecycle | Create → link workspace → messages → agent complete → idle → stop |
| WebSocket broadcasting | Subscriber receives message.new events |
| Concurrent message persistence | Two batches with overlapping messageIds → deduplicated correctly |
| Session without workspace link | Messages still persist, idle cleanup uses fallback path |
| Session creation under DO pressure | Multiple concurrent session creates succeed |

### Contract Tests (with VM Agent)

| Test Category | What to Test |
|--------------|-------------|
| Message batch format | VM agent sends correct JSON, control plane parses correctly |
| Retry behavior | VM agent retries on 5xx, does not retry on 4xx |
| Deduplication round-trip | Same batch sent twice, only one set of messages in DO |

---

## Key Files

| File | Action |
|------|--------|
| `apps/api/src/routes/task-submit.ts` | Make session creation required, remove fallback ID |
| `apps/api/src/services/task-runner.ts` | Remove session creation, add workspace-session linking |
| `apps/api/src/durable-objects/project-data.ts` | Add `linkSessionToWorkspace` RPC if needed |
| `apps/api/src/services/project-data.ts` | Add typed wrapper for new RPCs |
| `apps/api/src/routes/chat.ts` | Verify WebSocket subscription works for linked sessions |
| `packages/vm-agent/internal/messagereport/` | Add retry logic (coordinated with TDF-4) |
| `apps/api/tests/unit/chat-session.test.ts` | Create unit tests |
| `apps/api/tests/integration/chat-session-lifecycle.test.ts` | Create integration tests |
