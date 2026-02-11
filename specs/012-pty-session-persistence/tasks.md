# Tasks: PTY Session Persistence

**Input**: Design documents from `/specs/012-pty-session-persistence/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/websocket-protocol.md

**Tests**: Included per Constitution Principle II (Infrastructure Stability) — TDD required for critical paths.

**Organization**: Tasks grouped by user story to enable independent implementation and testing.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3)
- Include exact file paths in descriptions

---

## Phase 1: Setup (Configuration & Shared Infrastructure)

**Purpose**: Add new environment variables and foundational data structures that all user stories depend on.

- [x] T001 Add `PTY_ORPHAN_GRACE_PERIOD` and `PTY_OUTPUT_BUFFER_SIZE` env var parsing to `packages/vm-agent/internal/config/config.go` with defaults (0s disabled cleanup, 262144 bytes)
- [x] T002 Add `gracePeriod` and `bufferSize` fields to `ManagerConfig` and wire them into `NewManager()` in `packages/vm-agent/internal/pty/manager.go`
- [x] T003 [P] Implement `RingBuffer` struct in new file `packages/vm-agent/internal/pty/ring_buffer.go` with `NewRingBuffer()`, `Write()`, `ReadAll()`, `Len()`, `Reset()` per data-model.md
- [x] T004 [P] Write Go unit tests for `RingBuffer` in `packages/vm-agent/internal/pty/ring_buffer_test.go` — test: write under capacity, write at capacity, wrap-around overwrite, `ReadAll()` linearization order, concurrent write/read, `Reset()`, zero-length write

---

## Phase 2: Foundational (Session Lifecycle & Protocol)

**Purpose**: Core server-side session persistence infrastructure that MUST be complete before any user story can work end-to-end.

**CRITICAL**: No user story work can begin until this phase is complete.

### Session Model Extensions

- [x] T005 Add orphan-related fields to `Session` struct in `packages/vm-agent/internal/pty/session.go`: `Name`, `IsOrphaned`, `OrphanedAt`, `ProcessExited`, `ExitCode`, `OutputBuffer *RingBuffer`, `orphanTimer *time.Timer`, `attachedWriter` with getter/setter (`SetAttachedWriter()`, `GetAttachedWriter()`)
- [x] T006 Create `SessionInfo` struct in `packages/vm-agent/internal/pty/session.go` with fields: `ID`, `Name`, `Status`, `CreatedAt`, `LastActivityAt`, `WorkingDirectory`
- [x] T007 Modify session output reading to always write to `OutputBuffer` (in addition to attached writer when present) in `packages/vm-agent/internal/pty/session.go` — the output reader goroutine should call `outputBuffer.Write(data)` on every read, then conditionally write to `attachedWriter` if non-nil
- [x] T008 Add process exit detection: when PTY read returns EOF/error and process has exited, set `ProcessExited = true` and `ExitCode` on session in `packages/vm-agent/internal/pty/session.go`

### Manager Extensions

- [x] T009 Add `OrphanSession(sessionID string)` method to `packages/vm-agent/internal/pty/manager.go` — marks session orphaned, clears attached writer, starts `time.AfterFunc` orphan timer that calls cleanup
- [x] T010 Add `OrphanSessions(sessionIDs []string)` batch method to `packages/vm-agent/internal/pty/manager.go`
- [x] T011 Add `ReattachSession(sessionID string) (*Session, error)` to `packages/vm-agent/internal/pty/manager.go` — validates session exists and not exited, stops orphan timer, clears orphan state, returns session
- [x] T012 Add `GetActiveSessions() []SessionInfo` to `packages/vm-agent/internal/pty/manager.go` — returns all non-closed sessions with running/exited status
- [x] T013 Add `SetSessionName(sessionID, name string) error` to `packages/vm-agent/internal/pty/manager.go`

### WebSocket Protocol Extensions

- [x] T014 [P] Add new message type constants to `packages/vm-agent/internal/server/messages.go`: `MessageTypeListSessions`, `MessageTypeReattachSession`, `MessageTypeSessionReattached`, `MessageTypeScrollback`
- [x] T015 [P] Add new message types to TypeScript protocol in `packages/terminal/src/protocol.ts`: `list_sessions`, `reattach_session` (client→server encoders), `session_reattached`, `scrollback` (server→client type guards and parsers). Update `session_list` type to include `status` field per session.
- [x] T016 [P] Update `TerminalSession` and `PersistedSession` types in `packages/terminal/src/types/multi-terminal.ts`: add `serverSessionId` to `PersistedSession`, add `session_reattached` and `scrollback` to server message union type

### Tests for Foundational

- [x] T017 Write Go unit tests for orphan lifecycle in `packages/vm-agent/internal/pty/manager_test.go` — test: `OrphanSession` sets state correctly, `ReattachSession` cancels timer and clears state, `ReattachSession` returns error for exited session, `GetActiveSessions` returns correct statuses, orphan timer fires and cleans up session after grace period
- [x] T018 [P] Write Vitest tests for new protocol encoders/parsers in `packages/terminal/src/protocol.test.ts` — test: `encodeListSessions()`, `encodeReattachSession()`, `isSessionReattachedMessage()`, `isScrollbackMessage()`, updated `session_list` parsing with `status` field

**Checkpoint**: Foundation ready — session model supports orphan/reattach lifecycle, protocol supports new messages, all tests pass.

---

## Phase 3: User Story 1 — Survive Page Refresh (Priority: P1) MVP

**Goal**: PTY processes survive a browser page refresh. User refreshes, tabs reappear with reconnected sessions showing recent scrollback.

**Independent Test**: Open workspace, run `sleep 300`, refresh page, verify `sleep` is still running and tab reconnected.

### Server-Side (Go)

- [x] T019 [US1] Refactor `handleMultiTerminalWS()` in `packages/vm-agent/internal/server/websocket.go` to use global PTY Manager instead of per-connection session map — handler tracks attached session IDs in a local `map[string]struct{}` set, all create/close operations go through Manager
- [x] T020 [US1] Change WebSocket disconnect behavior in `handleMultiTerminalWS()` in `packages/vm-agent/internal/server/websocket.go` — on disconnect, call `Manager.OrphanSessions(attachedSessionIDs)` instead of closing sessions. Clear attached writer on each session.
- [x] T021 [US1] Add `list_sessions` message handler in `handleMultiTerminalWS()` in `packages/vm-agent/internal/server/websocket.go` — calls `Manager.GetActiveSessions()` and sends `session_list` response with status field
- [x] T022 [US1] Add `reattach_session` message handler in `handleMultiTerminalWS()` in `packages/vm-agent/internal/server/websocket.go` — calls `Manager.ReattachSession()`, resizes PTY, sends `session_reattached` confirmation, reads `OutputBuffer.ReadAll()` and sends as `scrollback` message, sets attached writer to resume live output, adds session ID to local attached set
- [x] T023 [US1] Update `create_session` handler to store tab name on session via `Manager.SetSessionName()` and initialize `OutputBuffer` at session creation in `packages/vm-agent/internal/server/websocket.go`
- [x] T024 [US1] Start persistent output reader goroutine at session creation (not per-WebSocket-connection) in `packages/vm-agent/internal/server/websocket.go` — reader writes to ring buffer always, writes to attached WebSocket writer when present

### Browser-Side (TypeScript)

- [x] T025 [US1] Update `useTerminalSessions` hook in `packages/terminal/src/hooks/useTerminalSessions.ts` to persist `serverSessionId` in sessionStorage alongside `name` and `order`. Set `serverSessionId` when `session_created` message is received. Load persisted `serverSessionId` on mount.
- [x] T026 [US1] Implement reconnection flow in `MultiTerminal.tsx` (`packages/terminal/src/MultiTerminal.tsx`): on WebSocket open, send `list_sessions`, receive `session_list`, match server sessions against persisted `serverSessionId` values, send `reattach_session` for matches, send `create_session` for non-matches or exited sessions. Update `serverSessionId` in sessionStorage for newly created sessions.
- [x] T027 [US1] Handle `session_reattached` and `scrollback` messages in `MultiTerminal.tsx` (`packages/terminal/src/MultiTerminal.tsx`): on `session_reattached`, update session status to 'connected'. On `scrollback`, write replay data to the corresponding xterm.js terminal instance.
- [x] T028 [US1] Update `ConnectionOverlay` in `packages/terminal/src/ConnectionOverlay.tsx` to show per-terminal "Reconnecting..." state during reattach (displayed on each terminal container while waiting for `session_reattached` response)

### Tests for User Story 1

- [x] T029 [US1] Write Go integration test in `packages/vm-agent/internal/server/websocket_test.go` — test: connect WS, create session, disconnect WS, reconnect WS, send `list_sessions` → verify session appears in list, send `reattach_session` → verify `session_reattached` and `scrollback` received
- [x] T030 [P] [US1] Write Vitest test for reconnect flow in `packages/terminal/src/hooks/useTerminalSessions.test.ts` — test: `serverSessionId` persisted after session creation, `serverSessionId` loaded on mount, matching logic (match found → reattach, match not found → create fresh, match found but exited → create fresh)

**Checkpoint**: Page refresh works end-to-end. Sessions survive refresh, scrollback replayed, tabs reconnect.

---

## Phase 4: User Story 2 — Brief Network Interruption Recovery (Priority: P2)

**Goal**: Sessions survive brief network drops. Output produced during disconnection is replayed on reconnect.

**Independent Test**: Toggle Chrome DevTools offline mode for 10 seconds, toggle back, verify sessions resume with missed output.

### Implementation

- [x] T031 [US2] Verify output buffering during disconnect in `packages/vm-agent/internal/pty/session.go` — ensure output reader goroutine continues writing to ring buffer when `attachedWriter` is nil (this should already work from T007/T024, this task is verification + edge case handling for rapid disconnect/reconnect)
- [x] T032 [US2] Handle reconnection timing in `packages/terminal/src/MultiTerminal.tsx` — ensure that if WebSocket reconnects while previous `list_sessions` response is still pending, the flow doesn't duplicate sessions or send double reattach requests. Add a `reconnecting` state guard.
- [x] T033 [US2] Ensure xterm.js terminal instances are NOT destroyed on WebSocket disconnect in `packages/terminal/src/MultiTerminal.tsx` — on disconnect, keep terminal DOM elements and xterm instances alive, show "Reconnecting..." overlay, on reconnect reattach to same xterm instances

### Tests for User Story 2

- [x] T034 [US2] Write Go test for output buffering during disconnect in `packages/vm-agent/internal/pty/session_test.go` — test: create session, detach writer (simulate disconnect), write output to PTY, verify ring buffer captures it, reattach writer, verify `ReadAll()` returns buffered output

**Checkpoint**: Network interruptions handled gracefully. Missed output replayed on reconnect.

---

## Phase 5: User Story 3 — Optional Orphan Cleanup After Abandonment (Priority: P3)

**Goal**: When configured, orphaned sessions (no reconnect within grace period) are automatically cleaned up, freeing resources.

**Independent Test**: Set `PTY_ORPHAN_GRACE_PERIOD` to a short value, create sessions, close browser tab, wait beyond grace period, check `/health` endpoint shows 0 sessions.

### Implementation

- [x] T035 [US3] Verify orphan timer cleanup fires correctly in `packages/vm-agent/internal/pty/manager.go` — ensure the `time.AfterFunc` callback acquires lock, checks session is still orphaned (not reattached), closes PTY process, removes from sessions map, frees ring buffer
- [x] T036 [US3] Handle concurrent cleanup safety in `packages/vm-agent/internal/pty/manager.go` — ensure that if `ReattachSession()` races with the orphan timer callback, only one wins (timer callback checks `IsOrphaned` under lock, `ReattachSession` stops timer under lock)
- [x] T037 [US3] Update `/health` endpoint in `packages/vm-agent/internal/server/routes.go` to report orphaned session count separately from active session count (aids debugging and testing)

### Tests for User Story 3

- [x] T038 [US3] Write Go test for orphan cleanup timing in `packages/vm-agent/internal/pty/manager_test.go` — test: orphan session with short grace period (e.g., 100ms), verify session cleaned up after grace period, verify `ReattachSession` before grace period cancels cleanup, verify race between reattach and timer is safe

**Checkpoint**: With cleanup enabled, orphaned sessions are cleaned up on schedule. No zombie processes accumulate.

---

## Phase 6: User Story 4 — VM Restart Graceful Degradation (Priority: P4)

**Goal**: When VM Agent restarts (all sessions lost), browser gracefully creates fresh sessions matching saved tab arrangement.

**Independent Test**: Restart VM Agent process, verify browser recreates tabs with saved names and fresh terminals.

### Implementation

- [x] T039 [US4] Ensure `list_sessions` returns empty list when no sessions exist in `packages/vm-agent/internal/server/websocket.go` (verify existing `GetActiveSessions()` handles empty map correctly)
- [x] T040 [US4] Verify browser reconnect flow handles empty `session_list` in `packages/terminal/src/MultiTerminal.tsx` — when server returns empty session list but browser has persisted tabs, create fresh sessions for all persisted tabs using saved names and order. Update `serverSessionId` with new IDs.

### Tests for User Story 4

- [x] T041 [US4] Write Vitest test for empty session list handling in `packages/terminal/src/hooks/useTerminalSessions.test.ts` — test: persisted sessions exist in sessionStorage, server returns empty `session_list`, verify browser creates fresh sessions with persisted names/order, verify new `serverSessionId` values are persisted

**Checkpoint**: VM restart handled gracefully. Users see familiar tabs with fresh terminals.

---

## Phase 7: Polish & Cross-Cutting Concerns

**Purpose**: Backward compatibility, documentation, and final validation.

- [ ] T042 Verify single-terminal mode (`/terminal/ws`) is unchanged — run existing single-terminal tests in `packages/vm-agent/` and verify no regressions (FR-013)
- [ ] T043 [P] Update CLAUDE.md active technologies section if not already updated by agent context script
- [ ] T044 [P] Update spec.md status from "Draft" to "Implemented" in `specs/012-pty-session-persistence/spec.md`
- [ ] T045 Run full Go test suite (`go test ./...` in `packages/vm-agent/`) and full Vitest suite (`pnpm test` in `packages/terminal/`) — fix any failures
- [ ] T046 Run `pnpm typecheck` and `pnpm lint` from repo root — fix any issues
- [ ] T047 Validate quickstart.md smoke test scenarios manually or via integration test

---

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 1 (Setup)**: No dependencies — can start immediately
- **Phase 2 (Foundational)**: Depends on Phase 1 completion — BLOCKS all user stories
- **Phase 3 (US1)**: Depends on Phase 2 — core MVP
- **Phase 4 (US2)**: Depends on Phase 3 (builds on reconnect flow)
- **Phase 5 (US3)**: Depends on Phase 2 (only needs orphan timer, independent of US1 browser work)
- **Phase 6 (US4)**: Depends on Phase 3 (needs browser reconnect flow)
- **Phase 7 (Polish)**: Depends on all desired user stories being complete

### User Story Dependencies

- **US1 (Page Refresh)**: Depends on Foundational (Phase 2) only — this IS the MVP
- **US2 (Network Interruption)**: Depends on US1 (extends the reconnect flow)
- **US3 (Orphan Cleanup)**: Can start after Phase 2 — mostly server-side, independent of browser work in US1
- **US4 (VM Restart)**: Depends on US1 (needs the browser reconnect logic from US1)

### Within Each User Story

- Server-side tasks before browser-side tasks (server provides the API)
- Model/manager changes before WebSocket handler changes
- Protocol changes before handler implementation
- Tests validate each phase

### Parallel Opportunities

**Phase 1:**
- T003 (ring buffer) and T004 (ring buffer tests) can run in parallel with T001/T002 (config)

**Phase 2:**
- T014 (Go message types), T015 (TS protocol), T016 (TS types) can all run in parallel
- T017 (Go orphan tests) and T018 (TS protocol tests) can run in parallel

**Phase 3 (US1):**
- T025 (TS session hook) can run in parallel with T019-T024 (Go server changes)
- T029 (Go integration test) and T030 (TS test) can run in parallel

**Phase 5 (US3) can run in parallel with Phase 4 (US2)** — they touch different concerns

---

## Parallel Example: Phase 2 Foundation

```bash
# These three protocol tasks touch different files and can run in parallel:
Task T014: "Add message type constants to packages/vm-agent/internal/server/messages.go"
Task T015: "Add message types to packages/terminal/src/protocol.ts"
Task T016: "Update types in packages/terminal/src/types/multi-terminal.ts"

# These two test tasks can run in parallel:
Task T017: "Go orphan lifecycle tests in packages/vm-agent/internal/pty/manager_test.go"
Task T018: "Vitest protocol tests in packages/terminal/src/protocol.test.ts"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Setup (config + ring buffer) — **4 tasks**
2. Complete Phase 2: Foundational (session model + protocol) — **14 tasks**
3. Complete Phase 3: User Story 1 (page refresh survival) — **12 tasks**
4. **STOP and VALIDATE**: Refresh page → sessions survive, scrollback replayed
5. Deploy/demo if ready — this alone delivers massive user value

### Incremental Delivery

1. Phase 1 + Phase 2 → Foundation ready
2. Add US1 (Page Refresh) → Test → Deploy (**MVP!**)
3. Add US2 (Network Interruption) → Test → Deploy
4. Add US3 (Orphan Cleanup) → Test → Deploy (can parallelize with US2)
5. Add US4 (VM Restart) → Test → Deploy
6. Phase 7 (Polish) → Final validation → Done

---

## Notes

- [P] tasks = different files, no dependencies between them
- [Story] label maps task to specific user story for traceability
- Each user story is independently testable at its checkpoint
- Constitution Principle II requires TDD for critical paths — tests included
- Constitution Principle XI requires configurable values — `PTY_ORPHAN_GRACE_PERIOD` and `PTY_OUTPUT_BUFFER_SIZE` env vars with defaults
- Single-terminal mode (`/terminal/ws`) is explicitly NOT modified (FR-013)
