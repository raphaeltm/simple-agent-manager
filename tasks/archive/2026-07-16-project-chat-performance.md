# Reduce Project-Chat CPU/Memory Overhead

## Problem

Project chat performs excessive work on every WebSocket session lifecycle event. The `useProjectWebSocket` hook debounces events at 500ms, but each debounced callback triggers `loadSessions()` which:

1. **Fetches ALL sessions** via `listChatSessions(projectId, { limit: 100 })` — replaces the entire `sessions` array reference
2. **Fetches ALL tasks** via `listProjectTasks(projectId, { limit: 200 })` — rebuilds `taskTitleMap` AND `taskInfoMap` from scratch
3. **Breaks every downstream memo** — `recentSessions`, `staleSessions`, `filteredRecent`, `filteredStale`, `lineageMap` all recompute because their input references change
4. **Re-renders SessionList and every SessionTreeItem** — even for sessions that didn't change

The WebSocket already sends focused deltas (`session.stopped` sends `{sessionId}`, `session.updated` sends changed fields), but the client ignores these payloads and refetches everything.

During bursty project events (agent dispatching subtasks, multiple sessions updating), the 500ms debounce still allows multiple full refetches per second, each triggering a cascade of map/list rebuilds.

## Research Findings

### Track A: WebSocket/Poll Payload Analysis

- **`broadcastEvent` in ProjectData DO** sends events with minimal payloads — `session.stopped`/`session.failed` send only `{sessionId}`, `session.updated` sends the changed fields plus `sessionId`, `session.created` sends a near-complete session object.
- The client's `useProjectWebSocket` ignores these payloads entirely — it just calls `onSessionChange` (which is `loadSessions`) for any session lifecycle event.
- The project-level (untagged) socket receives ALL events including `message.new`, `messages.batch`, `activity.new`, attention events, knowledge events, etc. — but only session lifecycle events trigger the refetch.

### Track B: Frontend State Update Analysis

- `loadSessions()` calls `setSessions(sessionResult.sessions)` — new array reference every time → all session-derived memos recompute.
- `buildTaskInfoMap()` creates a new `Map` on every call → `taskInfoMap` reference changes every time → `recentSessions`/`staleSessions` memo recomputes (depends on `[sessions, taskInfoMap]`).
- `SessionList` computes `lineageMap` via `useMemo([sessions, taskInfoMap])` — both inputs change on every event.
- `SessionTreeItem` computes `enrichedSession` via `useMemo([session, taskInfo])` — session reference changes even if data is identical.

### Key Files

- `apps/web/src/hooks/useProjectWebSocket.ts` — WebSocket hook, 500ms debounce, ignores payloads
- `apps/web/src/pages/project-chat/useProjectChatState.ts` — full refetch on every event
- `apps/web/src/pages/project-chat/useTaskGroups.ts` — `buildTaskInfoMap` helper
- `apps/web/src/pages/project-chat/SessionList.tsx` — `lineageMap` memo
- `apps/web/src/pages/project-chat/SessionTreeItem.tsx` — per-item `enrichedSession` memo
- `apps/web/src/pages/project-chat/types.ts` — constants
- `apps/api/src/durable-objects/project-data/index.ts` — `broadcastEvent` method

## Implementation Checklist

### Track A: Use WebSocket Deltas Instead of Full Refetch

- [ ] **A1. Extend `useProjectWebSocket` to expose typed event payloads** — instead of just calling `onSessionChange()`, parse the WebSocket message and pass the event type + payload to a new `onSessionEvent(type, payload)` callback. Keep the existing `onSessionChange` as a fallback for reconnect.
- [ ] **A2. Add a `useSessionReducer` hook** — a reducer that applies WebSocket delta events directly to the sessions array:
  - `session.created`: prepend new session to the array
  - `session.stopped` / `session.failed`: update matching session's `status` field in-place (new object, same array ref pattern via functional update)
  - `session.updated`: merge changed fields into matching session
  - `session.agent_completed`: update `agentCompletedAt` field on matching session
  - `session.activity`: update activity-related fields if needed for rendering
  - Full refetch only on: initial load, reconnect, scope change, or a periodic background sync (every 30s)
- [ ] **A3. Apply task info deltas from session events** — when `session.created` includes a `taskId`, fetch that single task's info rather than re-fetching all 200 tasks. Only rebuild `taskInfoMap` on initial load or periodic sync.
- [ ] **A4. Increase WebSocket debounce for full-refetch fallback** — the periodic background sync can use a longer interval (30s) since deltas handle the real-time path.

### Track B: Batch and Stabilize Frontend State

- [ ] **B1. Batch rapid WebSocket events into a single state update** — accumulate delta events during a microtask window (queueMicrotask or requestAnimationFrame) and apply them as a single reducer dispatch. This prevents N rapid events from causing N separate state updates → N render cycles.
- [ ] **B2. Stabilize `taskInfoMap` reference** — use a ref-based comparison: only call `setTaskInfoMap(newMap)` if the new map differs from the existing one (compare by key count + spot-check values). This prevents downstream memo invalidation when task data hasn't changed.
- [ ] **B3. Preserve session array item references** — when merging deltas, create new session objects only for the changed session; keep existing references for unchanged sessions. This lets `React.memo` or shallow comparison skip re-renders for unchanged `SessionTreeItem` components.
- [ ] **B4. Memoize `SessionTreeItem` with `React.memo`** — wrap the component so it only re-renders when its specific session/taskInfo actually changes.

### Tests

- [ ] **T1. Unit test `useSessionReducer`** — test each event type (created, stopped, failed, updated, agent_completed) applies correctly, preserves unchanged session references, and handles edge cases (event for unknown session, duplicate creation).
- [ ] **T2. Unit test event batching** — verify that multiple rapid events are coalesced into a single state update.
- [ ] **T3. Unit test `taskInfoMap` stability** — verify map reference doesn't change when rebuilt with identical data.

### Quality

- [ ] **Q1. Lint + typecheck clean**
- [ ] **Q2. All existing tests pass**
- [ ] **Q3. Playwright visual audit** — mobile (375x667) + desktop (1280x800), session list / sidebar / mobile drawer / active chat
- [ ] **Q4. No behavioral changes** — verify session list still shows correct states, stale filtering works, Fork/Retry visible, archive/complete controls work

## Acceptance Criteria

- [ ] WebSocket session events apply as deltas without triggering full session+task refetch
- [ ] Multiple rapid events within a frame are batched into a single state update
- [ ] Unchanged sessions preserve referential identity across updates
- [ ] `taskInfoMap` reference stable when data hasn't changed
- [ ] Full refetch only on: initial load, reconnect, scope change, periodic sync
- [ ] All existing project-chat functionality preserved (stale filter, search, Fork/Retry, archive/complete, mobile drawer, provisioning)
- [ ] Unit tests cover reducer logic and batching behavior
- [ ] Visual audit confirms no layout regressions
