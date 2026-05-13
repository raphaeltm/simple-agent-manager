# Durable Attention Markers with 2-Hour Human Input Expiry

## Problem

SAM needs durable attention state separate from task lifecycle status and notifications. When an agent calls `request_human_input`, the system creates a notification but does not persist a first-class attention marker. This means:

1. The chat list cannot reliably show which sessions need human action
2. Task-mode `needs_input` waits keep workspaces alive indefinitely
3. There is no mechanism to expire stale human input requests after 2 hours

## Research Findings

### Current Code Paths

- `apps/api/src/routes/mcp/instruction-tools.ts`: `handleRequestHumanInput()` validates input, emits notification via `notifyNeedsInput()`, returns success. No durable marker.
- `apps/api/src/services/notification.ts`: `notifyNeedsInput()` creates a notification of type `needs_input` with high urgency. Notifications are delivery/inbox artifacts.
- `apps/api/src/durable-objects/project-data/index.ts`: ProjectData DO owns sessions, messages, activity, idle cleanup. Has alarm system for idle cleanup + heartbeat + mailbox sweep.
- `apps/api/src/durable-objects/project-data/idle-cleanup.ts`: `processExpiredCleanups()` stops sessions, completes tasks in D1, stops workspaces.
- `apps/api/src/durable-objects/migrations.ts`: 19 migrations so far. Append-only.
- `apps/api/src/durable-objects/project-data/types.ts`: DO Env type with config env vars.
- `apps/api/src/durable-objects/project-data/row-schemas.ts`: Valibot schemas for all DO row types.
- `apps/api/src/durable-objects/project-data/sessions.ts`: `listSessions()` returns session rows with status, `parseChatSessionListRow()` adds `isIdle`/`isTerminated` derived fields.

### Key Patterns

- DO modules are split into dedicated files under `project-data/` (sessions.ts, messages.ts, idle-cleanup.ts, etc.)
- Each module exports pure functions taking `(sql, env, ...)` parameters
- ProjectData index.ts delegates to modules and handles broadcasting/alarm scheduling
- Row schemas use Valibot `parseRow()` with context strings for error messages
- `generateId()` uses `crypto.randomUUID()`
- Alarm system: `recalculateAlarm()` picks earliest of idle cleanup, heartbeat, workspace idle, mailbox times

### Architecture Decision

- Attention markers go in a new `session_attention_markers` table in DO SQLite (migration 020)
- New module `attention.ts` for marker CRUD
- Wire into `handleRequestHumanInput` to create `needs_input` marker
- Resolve markers when human messages are persisted
- Integrate expiry into DO alarm system
- Expose attention summary in session list/detail response

## Implementation Checklist

- [ ] 1. Add migration `020-session-attention-markers` to `apps/api/src/durable-objects/migrations.ts`
- [ ] 2. Add Valibot row schemas for attention markers in `row-schemas.ts`
- [ ] 3. Create `apps/api/src/durable-objects/project-data/attention.ts` module with:
  - `createAttentionMarker()` — insert marker with kind, source, expires_at
  - `resolveAttentionMarkers()` — set resolved_at on active markers for a session
  - `listActiveAttentionMarkers()` — get unresolved markers for a session
  - `getAttentionSummary()` — get latest active marker for session list enrichment
  - `getExpiredMarkers()` — find markers past expires_at that are still active
  - `computeAttentionAlarmTime()` — earliest expires_at of active markers
- [ ] 4. Add `HUMAN_INPUT_TIMEOUT_MS` to DO Env type in `types.ts`
- [ ] 5. Wire attention module into ProjectData DO (`index.ts`):
  - Add `createAttentionMarker()` public method
  - Add `resolveSessionAttentionMarkers()` public method
  - Add `getSessionAttentionSummary()` public method
  - Integrate `computeAttentionAlarmTime()` into `recalculateAlarm()`
  - Add attention expiry processing to `alarm()`
- [ ] 6. Resolve markers on human message: in `persistMessage()` and `persistMessageBatch()`, when role='user', resolve active markers for that session
- [ ] 7. Wire `handleRequestHumanInput` to create attention marker:
  - Add `createAttentionMarker` to project-data service
  - Call it from `handleRequestHumanInput` with kind='needs_input', expires_at=now+2h for task-mode
- [ ] 8. Add attention expiry processing: when expired task-mode `needs_input` markers are found, fail the task in D1, stop workspace, record activity
- [ ] 9. Enrich session list/detail with attention summary in `parseChatSessionListRow()`
- [ ] 10. Add tests:
  - Marker creation with correct fields
  - Human message resolves markers
  - Marker expiry processing fails task and stops workspace
  - Attention summary serialization in session list
  - Alarm scheduling includes attention expiry
  - handleRequestHumanInput creates marker (integration)

## Acceptance Criteria

- [ ] `request_human_input` creates a durable `needs_input` attention marker in ProjectData
- [ ] The marker is linked to session, task, workspace where available
- [ ] A human message after marker creation resolves the marker
- [ ] Task-mode `needs_input` expires after 2 hours (configurable via `HUMAN_INPUT_TIMEOUT_MS`)
- [ ] Expired task-mode human input fails the task and cleans up the workspace
- [ ] Session list/detail includes attention summary
- [ ] Notifications continue to be emitted alongside attention markers
- [ ] Tests cover creation, resolution, expiry, and serialization

## References

- Idea: `01KRHDE41CZGDYFY1W8GX738Y7`
- Related: `01KRHDCJKR0EA7WHF6CK2GJJDT` (immediate complete_task cleanup)
- Related: `01KRHDFS3Z69740KQX51V9ZJTK` (reconciliation depends on these markers)
- Related: `01KRHDJVAV1BF4WBJVXX29QH7M` (UX consumes these markers)
