# TDF-8: Frontend State Tracking — Reliable Task Progress & Chat Display

**Created**: 2026-02-27
**Priority**: Medium (consumer of all backend fixes)
**Classification**: `ui-change`, `cross-component-change`
**Dependencies**: TDF-2 (Orchestration Engine), TDF-5 (Workspace Lifecycle), TDF-6 (Chat Sessions), TDF-7 (Recovery)
**Blocked by**: TDF-2, TDF-5, TDF-6, TDF-7
**Blocks**: Nothing (final task in the series)

---

## Context

The frontend is the consumer of all the backend systems. It polls for task status, subscribes to WebSocket events for chat messages, shows provisioning progress, and displays errors. After the backend fixes in TDF-1 through TDF-7, the frontend needs to be updated to work with the new contracts and provide a reliable, informative user experience.

### Research References

- **Flow map**: `docs/task-delegation-flow-map.md`
  - Section "Phase 6: Frontend Tracking" — current polling and WebSocket flow
  - Section "Chat Message Flow" — WebSocket event stream
  - Section "Chat Session Lifecycle" — idle timer, follow-up messaging
- **Chat UI**: `apps/web/src/pages/ProjectChat.tsx`
- **Task submit form**: `apps/web/src/components/task/TaskSubmitForm.tsx`
- **Kanban board**: `apps/web/src/components/task/TaskKanbanBoard.tsx`
- **Shared types**: `packages/shared/src/types.ts`

---

## Problem Statement

The frontend currently:

1. **Polls for task status every 2-3s** — after TDF-2, the TaskRunner DO could provide real-time status via WebSocket, eliminating polling
2. **Receives a session ID that may not exist** — the `sess-fallback-{taskId}` pattern (fixed in TDF-6) means the frontend subscribes to a phantom session. After TDF-6, session IDs are always valid, but the frontend should still handle the edge case gracefully.
3. **Shows provisioning progress as a spinner** — no granular feedback on which step is executing. After TDF-2, execution steps are tracked in the DO and could be surfaced to the UI.
4. **Has no retry on WebSocket disconnection** — if the WebSocket drops, messages are lost until the user refreshes
5. **Error display is minimal** — task failures show `errorMessage` but no diagnostic context. After TDF-7, the error database has richer context that could be surfaced.

---

## Scope

### In Scope

- Update task status tracking to use new DO-based status events (if TDF-2 exposes WebSocket)
- Remove fallback session ID handling (it won't exist after TDF-6)
- Add granular provisioning progress (show current execution step, not just spinner)
- Add WebSocket reconnection with message catch-up (fetch missed messages on reconnect)
- Improve error display with diagnostic context from task failure records
- Show idle timer countdown accurately
- Add visual feedback for each execution step (node selection → provisioning → workspace setup → agent starting)
- Component tests for all status states
- Playwright tests for the full submission → execution → completion flow

### Out of Scope

- Backend changes (all handled by TDF-1 through TDF-7)
- Kanban board redesign (functional, just needs updated status mapping)
- Settings UI changes

---

## Acceptance Criteria

- [ ] Task status updates are received in real-time (WebSocket or fast polling, no 2-3s delay)
- [ ] No references to `sess-fallback-*` in frontend code
- [ ] Provisioning progress shows the current execution step with human-readable labels
- [ ] Each execution step has a visual indicator (pending, in progress, completed, failed)
- [ ] WebSocket disconnection triggers automatic reconnect with exponential backoff
- [ ] On reconnect, missed messages are fetched via REST API and merged into the chat
- [ ] Task failure displays the error message and relevant diagnostic context
- [ ] Idle timer countdown is accurate (synced with server-side timer)
- [ ] Follow-up message resets the idle timer and the UI reflects this
- [ ] Component tests for every task status × execution step combination
- [ ] Playwright tests for: submit → provision → running → complete, submit → error, idle → follow-up → continue
- [ ] All tests pass in CI

---

## Execution Step Display Mapping

| Execution Step | User-Facing Label | Visual State |
|---------------|-------------------|-------------|
| `node_selection` | "Finding a server..." | Spinner |
| `node_provisioning` | "Setting up a new server..." | Spinner + progress hint |
| `node_agent_ready` | "Waiting for server to start..." | Spinner |
| `workspace_creation` | "Creating workspace..." | Spinner |
| `workspace_ready` | "Setting up development environment..." | Spinner + potentially long wait |
| `agent_session` | "Starting AI agent..." | Spinner |
| `running` | "Agent is working..." | Active indicator, chat visible |
| `awaiting_followup` | "Agent completed. Send a follow-up or let it clean up." | Idle timer visible |

---

## Testing Requirements

### Component Tests (Vitest + React Testing Library)

| Test Category | What to Test |
|--------------|-------------|
| Status display | Each task status renders correct UI state |
| Execution step progress | Each step shows correct label and visual indicator |
| Step transitions | Transitioning between steps updates the display smoothly |
| Error display | Failed task shows error message and diagnostic info |
| Idle timer | Countdown displays and decrements, follow-up resets it |
| WebSocket messages | Incoming messages render in chat view |
| Reconnection | Disconnection shows indicator, reconnection fetches missed messages |

### Playwright E2E Tests

| Test Scenario | What to Verify |
|--------------|---------------|
| Happy path | Submit task → see provisioning progress → agent runs → messages appear → agent completes |
| Task failure | Submit task → provisioning fails → error displayed with context |
| Idle flow | Agent completes → idle timer shows → send follow-up → timer resets |
| Connection loss | WebSocket drops → reconnect indicator → reconnects → missed messages appear |
| Multiple tasks | Submit two tasks → both tracked independently → correct sessions |

### Visual Regression Tests

| What to Capture |
|----------------|
| Provisioning progress at each step |
| Error state display |
| Idle timer countdown |
| Chat message rendering |
| WebSocket disconnection indicator |

---

## Key Files

| File | Action |
|------|--------|
| `apps/web/src/pages/ProjectChat.tsx` | Update status tracking, add step progress, improve error display |
| `apps/web/src/components/task/TaskSubmitForm.tsx` | Update post-submit tracking |
| `apps/web/src/components/task/TaskKanbanBoard.tsx` | Update status mapping |
| `packages/shared/src/types.ts` | Ensure execution step types are shared |
| `apps/web/src/hooks/` | Add WebSocket reconnection hook |
| `apps/web/tests/` | Component tests |
| `apps/web/tests/e2e/` | Playwright tests |
