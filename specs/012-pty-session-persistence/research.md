# Research: PTY Session Persistence

**Feature**: 012-pty-session-persistence
**Date**: 2026-02-09

## Research Areas

### 1. Ring Buffer Implementation Strategy

**Decision**: Implement a custom Go ring buffer (`ring_buffer.go`) in `internal/pty/`.

**Rationale**: The Go standard library does not include a fixed-size circular byte buffer. Third-party options exist (`github.com/smallnest/ringbuffer`) but adding a dependency for ~60 lines of code violates Principle X (Simplicity — new dependencies require justification). A ring buffer for this use case needs only: `Write([]byte)`, `ReadAll() []byte`, `Len() int`, `Reset()`, and a configurable capacity.

**Alternatives considered**:
- `bytes.Buffer` with manual truncation: Requires periodic copying to enforce size limits; not truly O(1) append. Rejected for memory churn.
- `container/ring`: Designed for linked-list ring of `interface{}` values, not byte streams. Poor fit for contiguous byte buffering.
- Third-party `ringbuffer` package: Adds external dependency for trivial code. Rejected per Principle X.

**Design Details**:
- Fixed-capacity `[]byte` backing array, allocated once at session creation
- Write pointer wraps around on overflow (oldest data overwritten)
- `ReadAll()` returns linearized copy (tail-to-head order) for replay
- Thread-safe via `sync.Mutex` (writes from PTY reader goroutine, reads on reattach)
- Capacity configurable via `PTY_OUTPUT_BUFFER_SIZE` env var (default: 262144 bytes / 256 KB)

---

### 2. Session Lifecycle: Orphan State Machine

**Decision**: Extend the existing PTY `Session` struct with an `orphaned` state and per-session orphan timer.

**Rationale**: The current architecture destroys sessions on WebSocket disconnect. The minimal change is to add an orphan state that defers cleanup. The PTY Manager already tracks sessions in a `map[string]*Session` with mutex protection — we extend this rather than creating a parallel data structure.

**Alternatives considered**:
- Separate orphan registry (new struct): Creates two sources of truth for session lookup. Rejected for complexity.
- Global orphan timer (single timer for all sessions): Would clean up all sessions at once regardless of individual disconnect times. Rejected for poor UX.

**Design Details**:
- New session fields: `IsOrphaned bool`, `OrphanedAt time.Time`, `orphanTimer *time.Timer`, `outputBuffer *RingBuffer`
- On WebSocket disconnect: Mark sessions as orphaned, start per-session timer (grace period)
- On reattach: Cancel timer, clear orphaned state, replay buffer, resume live streaming
- On timer fire: Close PTY process, remove from registry, free buffer
- On natural PTY exit while orphaned: Mark `processExited = true`, keep in registry until timer fires or client queries session list (to inform client the session ended)

---

### 3. Session Ownership: Per-Connection vs Global Registry

**Decision**: Move session management from per-WebSocket-connection local maps to the global PTY Manager registry.

**Rationale**: Currently, `handleMultiTerminalWS()` maintains a local `map[string]*pty.Session` per WebSocket connection. Sessions are created via the Manager but tracked locally, and all are closed when the connection ends. For persistence, sessions must survive beyond a single WebSocket connection. The PTY Manager's global `sessions` map is the natural home — it already exists and is thread-safe.

**Alternatives considered**:
- Keep per-connection maps, add a separate orphan pool: Requires moving sessions between two maps on disconnect/reconnect. More complex state transitions. Rejected.
- New "SessionPool" abstraction: Unnecessary indirection over the existing Manager. Rejected per Principle X.

**Design Details**:
- `handleMultiTerminalWS()` no longer maintains a local session map
- All session operations (create, close, reattach) go through the PTY Manager
- WebSocket handler tracks which sessions it is "attached to" via a local set of session IDs
- On disconnect: Handler calls `Manager.OrphanSessions(sessionIDs)` instead of closing them
- On reconnect: Handler calls `Manager.ReattachSession(sessionID)` which cancels orphan timer and returns the session
- Output reader goroutines continue running even when WebSocket disconnects (they write to the ring buffer instead)

---

### 4. Output Streaming During Disconnection

**Decision**: Output reader goroutines always write to both the ring buffer AND the WebSocket (when connected). During disconnection, writes to the ring buffer continue; WebSocket writes are skipped.

**Rationale**: The simplest approach is to have the output reader always running and writing to the ring buffer. When a WebSocket is attached, the reader also sends output over the WebSocket. This avoids starting/stopping goroutines on connect/disconnect.

**Alternatives considered**:
- Stop reader on disconnect, restart on reconnect: Risk of losing output between stop and restart. Also complex goroutine lifecycle management.
- Buffer-only mode with polling: Client polls for buffered output. Adds latency, more complex protocol. Rejected.

**Design Details**:
- Each session has a persistent output reader goroutine (started at session creation, runs until session close)
- Reader writes every chunk to `session.outputBuffer.Write(data)`
- Reader checks `session.GetAttachedWriter()` — if non-nil, also writes to the WebSocket writer
- `AttachedWriter` is set on WebSocket attach, cleared on detach
- Thread-safe via atomic pointer or mutex-protected getter/setter
- On reattach: First replay `outputBuffer.ReadAll()`, then set `AttachedWriter` to resume live streaming

---

### 5. WebSocket Protocol Extensions

**Decision**: Add three new message types to the existing protocol: `list_sessions` (request), `session_list` (response, already exists), and `reattach_session` (request). Add `scrollback` as a new server message type for replay data.

**Rationale**: The `session_list` message type already exists in the protocol but is never sent automatically. We add a `list_sessions` request so the client can explicitly request it on reconnect. The `reattach_session` message is analogous to `create_session` but reconnects to an existing PTY instead of spawning a new one. The `scrollback` message distinguishes replay data from live output so the client can handle them differently (e.g., write without triggering activity callbacks).

**Alternatives considered**:
- Auto-send `session_list` on every WebSocket connect: Could work but gives the client no control over timing. The client may want to wait until its own state is loaded before requesting the list.
- Reuse `create_session` with an `attach: true` flag: Overloads the message semantics. Rejected for clarity.
- Reuse `output` for scrollback replay: Client can't distinguish replay from live output. Rejected.

**Design Details**:

New client → server messages:
- `list_sessions`: No payload. Server responds with `session_list` containing all active (non-closed) sessions for the authenticated user.
- `reattach_session`: `{ sessionId: string, rows: number, cols: number }`. Server reattaches and responds with `session_reattached` + `scrollback` data.

New server → client messages:
- `session_reattached`: `{ sessionId: string, workingDirectory?: string, shell?: string }`. Confirms reattach success.
- `scrollback`: `{ sessionId: string, data: string }`. Buffered output replay. Sent once immediately after `session_reattached`, before live output resumes.

Updated `session_list` payload:
- Add `status` field per session: `"running"` or `"exited"` (so browser can skip reattach for exited sessions)

---

### 6. Browser Reconnection Flow

**Decision**: On WebSocket reconnect, the browser sends `list_sessions`, compares server session IDs against sessionStorage, reattaches matches, and creates fresh sessions for unmatched browser tabs.

**Rationale**: This is the most robust approach. The server is the source of truth for which PTY processes are alive. The browser is the source of truth for which tabs the user had. Matching by session ID (persisted in sessionStorage) provides unambiguous 1:1 mapping.

**Alternatives considered**:
- Server auto-attaches all sessions on connect: Server doesn't know which tabs the browser has. Could show sessions the user already closed on the browser side.
- Browser blindly creates all sessions: Defeats the purpose of persistence.

**Design Details**:

1. WebSocket connects (or reconnects)
2. Browser sends `list_sessions`
3. Server responds with `session_list` (IDs, names, statuses)
4. Browser loads persisted tab metadata from sessionStorage (including session IDs from previous connection)
5. For each persisted tab:
   - If matching session ID found in server list with status `"running"`: Send `reattach_session`
   - If matching session ID found but status `"exited"`: Create fresh session (new ID), update sessionStorage
   - If no matching session ID in server list: Create fresh session (new ID), update sessionStorage
6. For server sessions not represented in browser tabs: Hydrate local tabs from server metadata and reattach so sessions remain discoverable after reload.
7. Display "Reconnecting..." overlay per terminal until `session_reattached` or `session_created` received
8. On `scrollback` message: Write replay data to xterm.js instance
9. On first `output` message after reattach: Live streaming resumes

---

### 7. SessionStorage Schema Update

**Decision**: Add `serverSessionId` field to the persisted session metadata in sessionStorage.

**Rationale**: Currently, `PersistedSession` only stores `name` and `order`. Session IDs are regenerated on every page load. To support reattach, the browser must persist the server-assigned session ID so it can request reattach on reconnect.

**Design Details**:

Updated `PersistedSession`:
```typescript
interface PersistedSession {
  name: string;           // Tab name (existing)
  order: number;          // Tab position (existing)
  serverSessionId: string; // Server-assigned session ID (new)
}
```

- `serverSessionId` is set when the server confirms session creation (`session_created` message)
- On reconnect, this ID is used to match against the server's `session_list`
- If the server doesn't recognize the ID (VM restart), the browser creates a fresh session

---

### 8. Backward Compatibility with Single-Terminal Mode

**Decision**: No changes to single-terminal mode (`/terminal/ws`). Session persistence only applies to multi-terminal mode (`/terminal/ws/multi`).

**Rationale**: FR-013 explicitly requires not breaking single-terminal mode. The single-terminal handler creates one session per WebSocket and closes it on disconnect. This behavior is correct for its use case and doesn't need persistence. The feature flag `featureFlags.multiTerminal` already gates which mode is used.

**Alternatives considered**:
- Add persistence to single-terminal mode too: No user demand, adds complexity for a deprecated path. Rejected.

---

### 9. Multi-Browser-Tab Behavior

**Decision**: Each browser tab maintains its own WebSocket connection and its own set of attached sessions. Sessions are shared in the global PTY Manager but a session can only be attached to one WebSocket writer at a time.

**Rationale**: FR-010 requires supporting multiple browser tabs. The simplest model is that each tab sees the authenticated user's full session list and can interact with those sessions. However, only one tab's WebSocket can receive live output from a given session at a time (last-attach-wins). This prevents duplicate output delivery.

**Design Details**:
- `session.GetAttachedWriter()` returns the most recently attached WebSocket writer
- If Tab A has Session 1 attached and Tab B sends `reattach_session` for Session 1, Tab B becomes the output receiver
- Tab A would stop receiving output but can re-request via its own `reattach_session`
- This is acceptable for the MVP — concurrent editing of the same session from multiple tabs is an edge case

---

### 10. Grace Period and Cleanup Timing

**Decision**: Each session can have an independent orphan timer when cleanup is enabled. By default (`PTY_ORPHAN_GRACE_PERIOD=0`), orphaned sessions are retained until explicitly closed.

**Rationale**: Explicit-close defaults improve long-running mobile workflows and avoid surprising session loss. For deployments that want automatic reclamation, per-session timers still provide precise cleanup.

**Design Details**:
- Grace period: Configurable via `PTY_ORPHAN_GRACE_PERIOD` env var (default: `0`, disabled)
- When grace period is `> 0`, timer created with `time.AfterFunc(gracePeriod, cleanupFunc)`
- `cleanupFunc` acquires Manager lock, checks session still orphaned, closes PTY, removes from registry
- On reattach: `timer.Stop()` cancels the pending cleanup
- On PTY process exit while orphaned: Session kept in registry (marked as exited) until timer fires, so client can discover the exit on reconnect
