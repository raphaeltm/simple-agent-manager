# Phase 3: Session Message Inbox (Event-Driven Upward Communication)

## Problem Statement

Parent agent sessions have no way to receive asynchronous notifications when child tasks complete, fail, or request input. Currently, parents must poll via `get_task_dependencies` or `get_subtask_summary` (Phase 2). This phase adds a per-session message inbox in the ProjectData DO that queues messages for delivery to parent sessions when they go idle.

## Research Findings

### Key Code Paths
- **ProjectData DO**: `apps/api/src/durable-objects/project-data/index.ts` — modular delegation pattern with pure functions in separate modules
- **Migrations**: `apps/api/src/durable-objects/migrations.ts` — lazy migration array, current highest is **014** (`014-user-message-content-dedup-index`)
- **Task completion**: `apps/api/src/routes/mcp/task-tools.ts:handleCompleteTask()` — updates D1 task status, emits notifications. No parentTaskId cascade currently.
- **Request human input**: `apps/api/src/routes/mcp/instruction-tools.ts:handleRequestHumanInput()` — emits needs_input notification. No parent inbox logic.
- **Task failure**: `apps/api/src/durable-objects/task-runner/state-machine.ts:failTask()` (lines 167-278) — updates D1, logs to observability, revokes MCP token, cleans up. No parentTaskId check.
- **sendPromptToAgentOnNode**: `apps/api/src/services/node-agent.ts:318-336` — POST to `/workspaces/{id}/agent-sessions/{sessionId}/prompt` with `{ prompt }`. Returns 202 on success, 409 when agent busy.
- **Resolving parent session**: Task → D1 `tasks.workspaceId` → D1 `workspaces.chatSessionId`. Helper `getChatSessionId()` exists in `notification.ts:295-307`.
- **Message batch endpoint**: `apps/api/src/routes/workspaces/runtime.ts:POST /:id/messages` — receives VM agent message batches, calls `persistMessageBatch()` on DO.

### Phase 1/2 Status
- Phase 1 branch (`sam/phase-1-downward-communication-01knkh`) NOT merged — adds `orchestration-tools.ts` with `send_message_to_subtask`, `stop_subtask`, and `resolveChildAgent()` helper.
- Phase 2 branch (`sam/phase-2-enhanced-polling-01knkh`) NOT merged — adds `get_subtask_summary` and enriched `get_task_dependencies`.
- Phase 3 work should be independent of Phase 1/2 since it operates on different code paths (completion/failure handlers + DO inbox, not orchestration tools).

### Patterns to Follow
- DO methods delegate to pure functions in separate modules (e.g., `sessions.ts`, `messages.ts`)
- Row validation via Valibot schemas in `row-schemas.ts`
- Config: `DEFAULT_*` constants + `parsePositiveInt(env.VAR, DEFAULT)` in `_helpers.ts`
- ID generation via `crypto.randomUUID()`
- Structured logging via `createModuleLogger()`

## Implementation Checklist

### 1. Migration: session_inbox table
- [ ] Add migration `015-session-inbox` to `apps/api/src/durable-objects/migrations.ts`
- [ ] CREATE TABLE session_inbox with: id, target_session_id, source_task_id, message_type, content, priority, created_at, delivered_at
- [ ] CREATE INDEX idx_inbox_pending on (target_session_id, delivered_at) WHERE delivered_at IS NULL

### 2. DO module: inbox.ts
- [ ] Create `apps/api/src/durable-objects/project-data/inbox.ts`
- [ ] Implement `enqueueInboxMessage(sql, targetSessionId, sourceTaskId, messageType, content, priority, maxSize)` — insert with overflow protection
- [ ] Implement `getPendingInboxMessages(sql, targetSessionId, limit)` — SELECT undelivered, ordered by created_at
- [ ] Implement `markInboxDelivered(sql, messageIds[])` — UPDATE delivered_at = now
- [ ] Implement `getInboxStats(sql, targetSessionId)` — count pending messages
- [ ] Add Valibot row schemas for inbox rows in `row-schemas.ts`

### 3. DO public methods
- [ ] Add `enqueueInboxMessage()` method to ProjectData class in `index.ts`
- [ ] Add `getPendingInboxMessages()` method
- [ ] Add `markInboxDelivered()` method
- [ ] Add `getInboxStats()` method

### 4. Configuration constants
- [ ] Add `ORCHESTRATOR_INBOX_MAX_SIZE` (default: 100) to `_helpers.ts` getMcpLimits
- [ ] Add `ORCHESTRATOR_INBOX_DRAIN_BATCH_SIZE` (default: 10)
- [ ] Add `ORCHESTRATOR_INBOX_MESSAGE_MAX_LENGTH` (default: 8192)
- [ ] Add env vars to Env type if needed

### 5. Helper: resolveParentSession
- [ ] Create helper function to resolve parentTaskId → parent workspace → parent chatSessionId
- [ ] Handle edge cases: no parent, parent completed, parent has no workspace/session

### 6. Enqueue on child task completion
- [ ] Modify `handleCompleteTask()` in `task-tools.ts` — after existing logic, check parentTaskId
- [ ] Query parent task from D1 to get workspace → chatSessionId
- [ ] Call ProjectData DO `enqueueInboxMessage()` with type 'child_completed'
- [ ] Include title, outputSummary, outputBranch in content
- [ ] Best-effort: catch and log errors, don't block completion

### 7. Enqueue on child task failure
- [ ] Modify `failTask()` in `state-machine.ts` — after existing logic, check parentTaskId
- [ ] Query parent task from D1 to get workspace → chatSessionId → projectId
- [ ] Call ProjectData DO `enqueueInboxMessage()` with type 'child_failed'
- [ ] Include title and error message in content
- [ ] Best-effort: catch and log errors, don't block failure handling

### 8. Enqueue on request_human_input with parent
- [ ] Modify `handleRequestHumanInput()` in `instruction-tools.ts`
- [ ] Check if task has parentTaskId AND parent task is in ACTIVE_STATUSES
- [ ] Call ProjectData DO `enqueueInboxMessage()` with type 'child_needs_input', priority 'urgent'
- [ ] Include question text and instructions for send_message_to_subtask
- [ ] Keep existing human notification as fallback

### 9. Inbox drain service
- [ ] Create `drainSessionInbox()` in a new service file or in `node-agent.ts`
- [ ] Fetch pending messages from DO
- [ ] Concatenate into single prompt with clear separators
- [ ] Call `sendPromptToAgentOnNode()` for parent session
- [ ] On 202 success: mark messages delivered
- [ ] On 409 (busy): leave in inbox for retry
- [ ] Call drain after message batch persistence (in runtime.ts POST /:id/messages handler or in DO persistMessageBatch)

### 10. Shared types
- [ ] Add `InboxMessage` type and `InboxMessageType` union to shared types
- [ ] Add config constants to shared if needed

### 11. Tests
- [ ] Test: enqueue on child completion → message in parent's inbox
- [ ] Test: enqueue on child failure → failure message in parent's inbox
- [ ] Test: enqueue on request_human_input with parent → inbox message + human notification preserved
- [ ] Test: drain when idle → message delivered → marked delivered
- [ ] Test: drain when busy (409) → message stays pending
- [ ] Test: inbox size limit → oldest dropped or new rejected
- [ ] Test: no parent → no inbox activity
- [ ] Test: parent completed → inbox enqueued but drain is no-op

## Acceptance Criteria

1. When a child task completes, a 'child_completed' message is enqueued in the parent session's inbox
2. When a child task fails, a 'child_failed' message is enqueued in the parent session's inbox
3. When a child task calls request_human_input and has a parent, a 'child_needs_input' message is enqueued with 'urgent' priority
4. Existing human notifications for request_human_input are preserved (fallback)
5. Inbox messages are delivered to the parent agent when it goes idle (drain mechanism)
6. Busy parent sessions (409) leave messages pending for retry
7. Inbox has configurable max size (ORCHESTRATOR_INBOX_MAX_SIZE, default 100)
8. Message content respects max length (ORCHESTRATOR_INBOX_MESSAGE_MAX_LENGTH, default 8192)
9. All inbox operations are best-effort — failures don't block the triggering operation
10. Tasks without parentTaskId produce no inbox activity

## References

- Task description: idea `01KNKGFAX12VQ34M48FTXV0K4P`
- Phase 1: `sam/phase-1-downward-communication-01knkh` (not merged)
- Phase 2: `sam/phase-2-enhanced-polling-01knkh` (not merged)
- `apps/api/src/durable-objects/project-data/index.ts`
- `apps/api/src/durable-objects/migrations.ts`
- `apps/api/src/routes/mcp/task-tools.ts`
- `apps/api/src/routes/mcp/instruction-tools.ts`
- `apps/api/src/durable-objects/task-runner/state-machine.ts`
- `apps/api/src/services/node-agent.ts`
