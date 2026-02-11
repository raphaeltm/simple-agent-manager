# Feature Specification: PTY Session Persistence

**Feature Branch**: `012-pty-session-persistence`
**Created**: 2026-02-09
**Status**: Implemented
**Input**: User description: "PTY Session Persistence Across Page Refresh — Keep terminal sessions alive on the VM when users refresh their browser, allowing seamless reconnection to existing PTY processes."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Survive Page Refresh (Priority: P1)

A user is working in a multi-terminal workspace with several active terminal sessions. They have a build running in one tab and are editing files in another. They accidentally refresh their browser page (or the browser auto-refreshes). When the page reloads and the WebSocket reconnects, the user sees the same terminal tabs they had before, each reconnected to its original PTY process. The running build is still going, the command history is visible, and the terminal scrollback shows recent output.

**Why this priority**: This is the core value proposition. Without it, a page refresh destroys all in-progress work — running builds, test suites, and server processes are lost. This is the most common frustration users experience.

**Independent Test**: Can be fully tested by opening a workspace, running a long command (e.g., `sleep 120`), refreshing the page, and verifying the command is still running and output is visible.

**Acceptance Scenarios**:

1. **Given** a user has 3 terminal sessions with running processes, **When** the user refreshes the browser page, **Then** all 3 terminal sessions reappear with their original names and reconnect to the same PTY processes within 5 seconds.
2. **Given** a user has a build outputting text in Terminal 1, **When** the page refreshes and reconnects, **Then** Terminal 1 displays recent scrollback output and continues showing new build output in real-time.
3. **Given** a user refreshes the page, **When** the WebSocket reconnects, **Then** tab order, names, and active tab selection are preserved (existing browser-side persistence).

---

### User Story 2 - Brief Network Interruption Recovery (Priority: P2)

A user experiences a brief network disruption (Wi-Fi drop, VPN reconnect, mobile network switch). The WebSocket disconnects and reconnects while sessions are still available (always when orphan cleanup is disabled; otherwise within the configured grace period). The user's terminal sessions seamlessly resume without losing any running processes or visible output.

**Why this priority**: Network interruptions are common, especially for mobile users and those on unreliable connections. Losing all terminal sessions for a 2-second network blip is a poor experience.

**Independent Test**: Can be tested by simulating a WebSocket disconnect (e.g., disable/re-enable network), waiting a few seconds, and verifying sessions resume.

**Acceptance Scenarios**:

1. **Given** a user has active terminal sessions, **When** the network drops for 10 seconds and recovers, **Then** all PTY sessions are still alive and the user reconnects to them automatically.
2. **Given** a WebSocket disconnects, **When** the client reconnects while sessions are still retained, **Then** no new PTY processes are spawned — existing ones are reattached.
3. **Given** output was produced while the WebSocket was disconnected, **When** the client reconnects, **Then** the missed output is replayed so the terminal display is up-to-date.

---

### User Story 3 - Orphan Cleanup After Abandonment (Priority: P3)

A user closes their browser tab entirely (not a refresh — a full close). By default, PTY sessions remain alive until explicitly closed by the user. If orphan cleanup is enabled, sessions continue running for the configured grace period and are then cleaned up automatically when no reconnect occurs.

**Why this priority**: Explicit-close semantics protect long-running workflows. Optional cleanup remains important for operators who prefer automatic reclamation.

**Independent Test**: Can be tested by connecting, creating sessions, fully closing the browser, and verifying either persistence (default behavior) or cleanup (when `PTY_ORPHAN_GRACE_PERIOD` is set to a positive value).

**Acceptance Scenarios**:

1. **Given** `PTY_ORPHAN_GRACE_PERIOD=0`, **When** a user closes their browser tab with 3 active PTY sessions, **Then** all 3 sessions remain available for later reattachment until explicitly closed.
2. **Given** orphaned sessions exist, **When** a different user (or the same user in a new browser tab) connects, **Then** they do not see or have access to the orphaned sessions.
3. **Given** a user closes their browser tab, **When** they open a new tab and navigate to the workspace later, **Then** they reconnect to existing sessions if still retained by configuration.

---

### User Story 4 - VM Restart Graceful Degradation (Priority: P4)

When the VM restarts (e.g., after a crash or system update), all PTY sessions are naturally lost. The browser-side persistence still has the tab arrangement. When the user's browser reconnects, it requests the session list from the server, discovers no sessions exist, and creates fresh PTY sessions matching the persisted tab arrangement (names and order).

**Why this priority**: This is an edge case but must be handled gracefully to avoid confusing users or causing errors.

**Independent Test**: Can be tested by restarting the VM Agent process and verifying the browser creates fresh sessions with preserved tab names.

**Acceptance Scenarios**:

1. **Given** the VM Agent restarts while a user has 3 tabs in their browser, **When** the browser reconnects and requests the session list, **Then** the server returns an empty session list.
2. **Given** the server returns an empty session list but the browser has persisted tab metadata, **When** the session list is empty, **Then** the browser creates new PTY sessions using the persisted tab names and order.
3. **Given** the server returns an empty session list, **When** new sessions are created, **Then** the user sees their familiar tab arrangement but with fresh terminals (no previous scrollback).

---

### Edge Cases

- If orphan cleanup is enabled and the grace period expires while output is being buffered, cleanup must safely stop the output buffer reader before freeing resources.
- What happens when two browser tabs connect to the same workspace simultaneously? Each tab should get its own WebSocket connection but both should be able to interact with the shared pool of PTY sessions.
- What happens if a PTY process exits naturally (e.g., `exit` command) while the WebSocket is disconnected? The session should be marked as closed and not available for reattach; the browser should handle this on reconnect.
- What happens if the scrollback buffer fills up? The buffer operates as a ring buffer — oldest output is overwritten by newest output, maintaining a fixed memory footprint.
- What happens when a user creates new sessions from a second browser tab while existing sessions from the first tab are orphaned? New sessions are created normally; orphaned sessions remain available for reattach while retained by configuration.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST keep PTY processes alive after a WebSocket disconnection. By default sessions persist until explicitly closed (`PTY_ORPHAN_GRACE_PERIOD=0`), with optional timed cleanup when configured.
- **FR-002**: The system MUST provide a mechanism for reconnecting clients to request a list of active PTY sessions associated with their connection.
- **FR-003**: The system MUST allow a reconnecting client to reattach to an existing PTY session by session ID instead of creating a new one.
- **FR-004**: The system MUST replay buffered recent output when a client reattaches to a PTY session, so the terminal display shows recent history.
- **FR-005**: When `PTY_ORPHAN_GRACE_PERIOD` is greater than 0, the system MUST automatically clean up orphaned PTY sessions (no active WebSocket attachment) after the configured grace period expires.
- **FR-006**: The system MUST limit memory usage per orphaned session's output buffer to a configurable maximum (default: 256 KB).
- **FR-007**: The system MUST continue capturing PTY output into the buffer while no WebSocket is connected, so output produced during disconnection is not lost.
- **FR-008**: The system MUST handle the case where a PTY process exits while orphaned — the session should be marked as closed and not offered for reattach.
- **FR-009**: The browser MUST request the server's active session list on reconnect and match it against browser-persisted session metadata to determine which sessions to reattach vs. create fresh. Matching is performed by session ID: the browser persists each server-assigned session ID alongside tab metadata in sessionStorage, enabling unambiguous 1:1 matching on reconnect.
- **FR-014**: During reconnection, the browser MUST display existing tabs immediately (from browser-persisted metadata) with a per-terminal "Reconnecting..." overlay, replacing it with terminal content once the session is reattached and scrollback is replayed.
- **FR-010**: The system MUST support multiple browser tabs connected to the same workspace, with each tab able to interact with the shared PTY session pool.
- **FR-011**: The orphan cleanup grace period duration MUST be configurable via environment variable with default `0` (disabled).
- **FR-012**: The output buffer size per session MUST be configurable via environment variable with a sensible default.
- **FR-013**: The system MUST NOT break existing single-terminal (non-multi) WebSocket mode, which does not use session persistence.

### Key Entities

- **PTY Session**: A running pseudo-terminal process on the VM. Key attributes: session ID, creation time, last activity time, process state (running/exited), attached/orphaned status, output ring buffer.
- **Session Registry**: An in-memory store mapping session IDs to PTY sessions. Persists across WebSocket connections (within the same VM Agent process lifetime). Already partially exists as the PTY Manager's `sessions` map.
- **Output Ring Buffer**: A fixed-size circular buffer capturing recent PTY output per session. Used to replay scrollback on reconnect. Bounded to prevent memory exhaustion.
- **Orphan Timer**: A per-session timer used only when cleanup is enabled (`PTY_ORPHAN_GRACE_PERIOD > 0`). It starts when a session becomes detached and is cancelled if a client reattaches before expiry.

## Assumptions

- The VM Agent process runs continuously for the lifetime of a workspace. PTY persistence is in-memory only — if the VM Agent process restarts, all sessions are lost (graceful degradation per User Story 4).
- Session ownership is tracked per-user in multi-terminal mode. Session listing and control operations are scoped to the authenticated user ID.
- The existing browser-side sessionStorage persistence (tab names, order, counter) from spec 011 continues to work alongside server-side PTY persistence. They complement each other: browser remembers UI arrangement, server keeps processes alive.
- The scrollback replay sends output as a single batch message before resuming real-time output streaming. The client is responsible for writing the replayed data to the terminal emulator.

## Clarifications

### Session 2026-02-09

- Q: What should the default grace period duration be? → A: Disabled (`0`) so sessions persist until explicitly closed; operators can set a positive value when automatic cleanup is desired.
- Q: What should the default output buffer size per session be? → A: 256 KB (~4,000 lines) — sufficient for most build/test output while keeping memory bounded (~2.5 MB for 10 orphaned sessions).
- Q: What should the user see during reconnection? → A: Existing tabs appear immediately (from browser-persisted metadata) with a subtle per-terminal "Reconnecting..." overlay; content replaces overlay once reattached.
- Q: How should the browser match server sessions to browser tabs on reconnect? → A: By session ID — browser persists each server-assigned session ID in sessionStorage alongside tab metadata for unambiguous 1:1 matching.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Users retain running processes across a page refresh 100% of the time while sessions are retained by configuration.
- **SC-002**: Terminal scrollback displays at least the last 256 KB of output upon reconnection, with no visible gap to the user.
- **SC-003**: Reconnection to existing sessions completes within 2 seconds of the WebSocket connection being established.
- **SC-004**: When cleanup is enabled (`PTY_ORPHAN_GRACE_PERIOD > 0`), orphaned sessions are cleaned up within 5 seconds of the grace period expiring, freeing all associated memory and process resources.
- **SC-005**: Memory usage per orphaned session stays below the configured buffer size limit plus a reasonable overhead (process metadata).
- **SC-006**: The feature works transparently — users do not need to take any special action to benefit from session persistence; it happens automatically on every page refresh or network recovery.
