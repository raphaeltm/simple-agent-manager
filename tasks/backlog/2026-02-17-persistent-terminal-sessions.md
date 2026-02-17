# Persistent Terminal Sessions (SessionHost Pattern for PTY)

**Status:** backlog
**Priority:** high
**Estimated Effort:** 1-2 weeks
**Created:** 2026-02-17

## Problem Statement

Terminal sessions time out and become unusable when the user disconnects or leaves the browser idle. Unlike chat/agent sessions — which use the `SessionHost` pattern to survive disconnects, support multi-device viewing, and replay buffered messages — terminal sessions are directly bound to a single WebSocket connection.

### Current Behavior

1. **Single viewer**: Only one WebSocket connection can receive terminal output at a time. Opening a second browser tab creates new sessions instead of viewing existing ones.
2. **No output during disconnect**: When the WebSocket disconnects, the PTY `attachedWriter` is set to `nil`. Output is captured by the ring buffer (256 KB), but there is no fan-out — only the next reconnecting client gets the scrollback.
3. **Session timeout/staleness**: If the user leaves for a while, the WebSocket connection drops (e.g., device sleep, network change) and the terminal appears "dead" on return. While the PTY process itself survives (orphan/reattach exists), the reconnection UX is unreliable.
4. **No multi-device support**: A user can't see the same terminal output streaming on their laptop and phone simultaneously.

### Desired Behavior

1. Terminal sessions should "just work" — leave for hours, come back, see your shell exactly as you left it with all output preserved.
2. Multiple browser tabs/devices should see the same terminal output streaming in real-time (same as chat sessions today).
3. Closing the browser tab should NOT kill the terminal process. Only explicitly closing the tab via the UI should end the PTY session.
4. Reconnecting should replay all buffered output seamlessly.

## Architecture Analysis

### What Already Works (Reusable)

The terminal system already has partial persistence infrastructure:

| Component | Status | Notes |
|-----------|--------|-------|
| PTY process survives disconnect | **Working** | `OrphanSession()` / `ReattachSession()` in pty/manager.go |
| Ring buffer captures output while disconnected | **Working** | 256 KB `RingBuffer` per session, always written to regardless of viewer |
| `list_sessions` / `reattach_session` protocol | **Working** | Browser asks for server state, reattaches to existing sessions |
| `sessionStorage` persistence | **Working** | Browser tracks session IDs across page refreshes |
| SQLite tab persistence | **Working** | Terminal tabs persisted for cross-device session discovery |
| `StartOutputReader` goroutine | **Working** | Runs independently of WebSocket, reads from PTY fd continuously |
| Orphan grace period = 0 (never expires) | **Working** | Orphaned sessions survive indefinitely (until workspace stops) |

### What's Missing (Gap Analysis vs. Agent SessionHost)

| Feature | Agent Sessions (SessionHost) | Terminal Sessions (Current) |
|---------|------------------------------|----------------------------|
| **Process owner** | `SessionHost` struct (independent of WebSocket) | PTY Manager (but I/O binding is per-WebSocket) |
| **Multi-viewer fan-out** | Yes — `map[string]*Viewer` with `broadcastMessage()` | No — single `attachedWriter io.Writer` per session |
| **Viewer send buffer** | Buffered `chan []byte` per viewer with dedicated `viewerWritePump` goroutine | Direct `conn.WriteJSON` on the WebSocket (blocks on slow clients) |
| **Message-level replay buffer** | `[]BufferedMessage` with sequence numbers (5000 entries) | Raw byte ring buffer (256 KB) — no sequence tracking |
| **WebSocket = thin relay** | `Gateway` struct reads WS, routes to SessionHost, detaches on close | WebSocket handler directly manages PTY I/O binding in `handleMultiTerminalWS` |
| **Ping/pong stale detection** | `ACPPingInterval` / `ACPPongTimeout` with server-side timeouts | Client-side ping only (`PING_INTERVAL_MS = 30s`), no server-side stale detection |

## Implementation Plan

### Core Idea

Introduce a `TerminalSessionHost` (or adapt the pattern) that mirrors `SessionHost` for PTY sessions:

- **Owns the PTY session** independently of any WebSocket connection
- **Maintains a viewer map** with fan-out broadcasting
- **Buffers output** in a bounded buffer for late-join replay
- **Is created once** per terminal session and lives until the user explicitly closes the tab
- **WebSocket handler becomes a thin relay** — attach viewer on connect, detach on disconnect

### Phase 1: VM Agent — TerminalSessionHost (Go)

#### 1.1 New `TerminalSessionHost` struct

**File:** `packages/vm-agent/internal/pty/terminal_host.go` (new)

Create a `TerminalSessionHost` that wraps a PTY `Session` and provides the multi-viewer pattern:

```go
type TerminalSessionHost struct {
    session     *Session           // The owned PTY session
    config      TerminalHostConfig

    // Viewers (guarded by viewerMu)
    viewerMu    sync.RWMutex
    viewers     map[string]*TerminalViewer

    // Output buffer for late-join replay (structured messages)
    bufMu       sync.RWMutex
    outputBuf   []BufferedOutput
    seqCounter  uint64

    ctx         context.Context
    cancel      context.CancelFunc
}

type TerminalViewer struct {
    ID     string
    sendCh chan []byte       // Buffered channel for non-blocking fan-out
    done   chan struct{}
    once   sync.Once
}

type BufferedOutput struct {
    Data      []byte
    SeqNum    uint64
    Timestamp time.Time
}

type TerminalHostConfig struct {
    OutputBufferSize int  // Max buffered output messages (default from env: TERMINAL_MESSAGE_BUFFER_SIZE)
    ViewerSendBuffer int  // Per-viewer channel buffer (reuse ACP_VIEWER_SEND_BUFFER or new TERMINAL_VIEWER_SEND_BUFFER)
    PingInterval     time.Duration
    PongTimeout      time.Duration
}
```

Key methods:
- `AttachViewer(id string, conn *websocket.Conn) *TerminalViewer` — registers viewer, replays buffered output, starts write pump
- `DetachViewer(id string)` — removes viewer, does NOT stop PTY
- `broadcastOutput(data []byte)` — appends to buffer + sends to all viewers
- `viewerWritePump(viewer *TerminalViewer)` — dedicated goroutine per viewer draining send channel
- `HandleInput(viewerID string, data string)` — writes to PTY stdin
- `HandleResize(rows, cols int)` — resizes PTY
- `Stop()` — kills PTY, disconnects all viewers (explicit close only)

#### 1.2 Wire TerminalSessionHost into output reader

When `StartOutputReader` runs, instead of checking `GetAttachedWriter()` for a single writer, it calls `host.broadcastOutput(payload)` to fan out to all viewers. The existing `RingBuffer` can be kept as the low-level byte buffer (for raw scrollback on fresh attach), while the `outputBuf []BufferedOutput` provides structured message replay.

**Decision: Two-tier buffering**
- **Ring buffer (bytes)**: Kept as-is. Used for initial scrollback when a session is first reattached (the "full history" dump). This is the existing 256 KB buffer.
- **Message buffer (structured)**: New. Used for incremental output replay when a viewer connects to an already-active host. This provides sequence-numbered messages so viewers know exactly what they missed. Size configurable via `TERMINAL_MESSAGE_BUFFER_SIZE` (default: 5000 to match ACP).

Why both? The ring buffer captures raw bytes efficiently for the "show me everything" case (first attach). The message buffer provides the "what did I miss since sequence N?" case (late-join/reconnect). This mirrors how ACP uses a message buffer for structured JSON-RPC messages.

#### 1.3 TerminalSessionHost registry

**File:** `packages/vm-agent/internal/server/server.go` (modify)

Add a `terminalHosts` map to the `WorkspaceRuntime` or `Server` struct:

```go
type WorkspaceRuntime struct {
    // ... existing fields ...
    terminalHosts map[string]*TerminalSessionHost  // keyed by sessionID
    thMu          sync.RWMutex
}
```

Add `getOrCreateTerminalHost(sessionID string) *TerminalSessionHost` that:
1. Checks if a host already exists for this session
2. If yes, returns it
3. If no, creates the PTY session via `runtime.PTY.CreateSessionWithID()`, wraps it in a new `TerminalSessionHost`, starts the output reader, and stores it

#### 1.4 Refactor `handleMultiTerminalWS`

**File:** `packages/vm-agent/internal/server/websocket.go` (modify)

Transform the existing handler into a thin relay:

**Current flow:**
```
WebSocket connect → create PTY → bind writer → read loop → orphan on disconnect
```

**New flow:**
```
WebSocket connect → for each session:
    getOrCreateTerminalHost(sessionID) → host.AttachViewer(viewerID, conn)
    
Message routing:
    "create_session"   → getOrCreateTerminalHost(id) → host.AttachViewer()
    "reattach_session" → getTerminalHost(id)         → host.AttachViewer()
    "close_session"    → host.Stop()                 → remove from registry
    "input"            → host.HandleInput(data)
    "resize"           → host.HandleResize(rows, cols)
    "list_sessions"    → iterate terminalHosts, return session info
    "ping"             → pong
    
WebSocket disconnect → for each attached host: host.DetachViewer(viewerID)
                       (PTY keeps running, other viewers keep receiving output)
```

The `defer` cleanup block changes from orphaning sessions to just detaching the viewer.

#### 1.5 Server-side ping/pong with stale detection

Add server-initiated WebSocket pings (like ACP does) to detect stale connections proactively:

```go
// In the terminal WebSocket handler read loop:
conn.SetReadDeadline(time.Now().Add(pongTimeout))
conn.SetPongHandler(func(string) error {
    conn.SetReadDeadline(time.Now().Add(pongTimeout))
    return nil
})

// Separate goroutine:
ticker := time.NewTicker(pingInterval)
for range ticker.C {
    conn.WriteControl(websocket.PingMessage, nil, time.Now().Add(writeWait))
}
```

Use existing config values `ACPPingInterval` / `ACPPongTimeout` or add terminal-specific ones (`TERMINAL_PING_INTERVAL`, `TERMINAL_PONG_TIMEOUT`).

### Phase 2: Configuration (Constitution Principle XI Compliance)

**File:** `packages/vm-agent/internal/config/config.go` (modify)

Add new environment variables:

| Env Var | Default | Description |
|---------|---------|-------------|
| `TERMINAL_MESSAGE_BUFFER_SIZE` | 5000 | Max buffered output messages per terminal host for late-join replay |
| `TERMINAL_VIEWER_SEND_BUFFER` | 256 | Per-viewer send channel buffer size |
| `TERMINAL_PING_INTERVAL` | 30s | Server-side WebSocket ping interval |
| `TERMINAL_PONG_TIMEOUT` | 10s | Pong deadline after ping |

### Phase 3: Browser Client Updates

#### 3.1 Multi-device output streaming (already mostly works)

The browser `MultiTerminal` component already:
- Sends `list_sessions` on connect
- Handles `reattach_session` / `scrollback` messages
- Tracks sessions in `sessionStorage`

The key change is that the **server now fan-outs output to all connected WebSocket clients**. The browser doesn't need to change much — it will just work because each connected browser opens its own WebSocket, and each gets attached as a viewer.

However, verify and fix:
- **Multiple WebSocket connections per workspace**: Currently, if two browser tabs open WebSockets to the same workspace, they each get their own viewer. Make sure the browser doesn't create new sessions if sessions already exist on the server. The `list_sessions` → `reattach_session` flow should handle this, but test it.
- **Output deduplication**: If a browser was connected during live output AND receives a scrollback replay, there could be duplicate lines. The scrollback replay should only be sent for the period the viewer was disconnected. Consider sending scrollback only on `reattach_session`, not on the initial `session_created` response (since the viewer was there from the start).

#### 3.2 Remove client-side timeout assumptions

Review the browser client for any assumptions that a session is "dead" after inactivity. The terminal should never show an error state just because no output has arrived for a while.

### Phase 4: Cleanup and Edge Cases

#### 4.1 Process exit handling

When a PTY process exits (user types `exit`, shell crashes):
- `TerminalSessionHost` detects process exit via the output reader goroutine
- Broadcasts a `session_closed` message with reason to all viewers
- Marks the host as stopped
- Removes from the registry
- Cleans up the persisted tab

#### 4.2 Session lifecycle events

Emit events for terminal session lifecycle (like agent sessions do):
- `terminal.session_created` — new PTY session started
- `terminal.viewer_attached` — browser connected to existing session
- `terminal.viewer_detached` — browser disconnected (session continues)
- `terminal.session_closed` — user explicitly closed the tab
- `terminal.process_exited` — PTY process ended (shell exit, crash)

#### 4.3 Graceful handling of workspace stop/delete

When a workspace is stopped or deleted:
- All `TerminalSessionHost` instances for that workspace should be stopped
- All viewers should receive close messages
- This should already happen via the existing workspace lifecycle, but verify

## Files to Modify

### VM Agent (Go)
| File | Change |
|------|--------|
| `packages/vm-agent/internal/pty/terminal_host.go` | **New** — TerminalSessionHost struct with multi-viewer fan-out |
| `packages/vm-agent/internal/pty/session.go` | Modify output reader to call host broadcast instead of single writer |
| `packages/vm-agent/internal/server/websocket.go` | Refactor `handleMultiTerminalWS` to thin relay pattern |
| `packages/vm-agent/internal/server/server.go` | Add terminalHosts registry to WorkspaceRuntime |
| `packages/vm-agent/internal/config/config.go` | Add TERMINAL_* config vars |

### Browser (TypeScript)
| File | Change |
|------|--------|
| `packages/terminal/src/MultiTerminal.tsx` | Verify multi-tab behavior, remove stale-session assumptions |
| `packages/terminal/src/hooks/useTerminalSessions.ts` | Review timeout/error state logic |

### Documentation
| File | Change |
|------|--------|
| `CLAUDE.md` | Add new env vars, update Recent Changes |
| `AGENTS.md` | Same (sync directive) |

## Testing Strategy

### Unit Tests
- [ ] `TerminalSessionHost` — attach/detach viewers, verify fan-out
- [ ] `TerminalSessionHost` — output buffer eviction at capacity
- [ ] `TerminalSessionHost` — replay sends all buffered messages to new viewer
- [ ] `TerminalSessionHost` — Stop() kills PTY and disconnects all viewers
- [ ] `TerminalSessionHost` — viewer send buffer full → message dropped (not blocked)
- [ ] Ping/pong stale detection — viewer removed after pong timeout
- [ ] Process exit detection — broadcasts session_closed to all viewers

### Integration Tests
- [ ] Connect two WebSocket clients to same workspace — both receive output
- [ ] Disconnect client A, type in client B — reconnect client A, verify scrollback
- [ ] Close browser tab — PTY process still running, output still buffered
- [ ] Reopen browser — sessions restored from server, scrollback replayed
- [ ] Long idle period (>30 min) — reconnect and verify session still works
- [ ] Explicit close (close_session) — PTY killed, host cleaned up, tab removed

### Manual/Playwright Testing
- [ ] Open workspace on laptop and phone — both see same terminal output
- [ ] Type on phone — see output on laptop in real-time
- [ ] Close laptop lid for 10 minutes — reopen, terminal works immediately
- [ ] Create multiple terminal tabs — all survive disconnect/reconnect independently

## Security Considerations

- Viewer authentication: Each WebSocket connection is already authenticated via JWT. The `TerminalSessionHost` should verify that the viewer's `userID` matches the session's `userID` before attaching.
- Viewer isolation: A viewer for workspace A must not be able to attach to a terminal host for workspace B. The registry is per-workspace, so this is naturally enforced.
- No new attack surface: This change doesn't add new endpoints or authentication flows — it restructures internal plumbing within the existing authenticated WebSocket connection.

## Success Criteria

- [ ] Terminal sessions survive browser disconnects indefinitely (until explicit close)
- [ ] Reconnecting replays all missed output seamlessly
- [ ] Multiple browser tabs/devices see the same terminal output in real-time
- [ ] No terminal "timeout" behavior — sessions are always usable on return
- [ ] Explicit close (X button on tab) is the only way to end a terminal session
- [ ] No regression in terminal performance or responsiveness
- [ ] All configurable values use environment variables with defaults

## Dependencies

None — can be implemented independently.

## Related Work

- `persistent-agent-sessions` (completed) — The `SessionHost` pattern this task replicates for terminals
- `012-pty-session-persistence` — The original PTY persistence work that added ring buffers and reattach

## Notes

- The existing orphan/reattach mechanism in `pty/manager.go` provides the foundation. The main work is adding the multi-viewer fan-out layer on top.
- The `RingBuffer` (raw bytes) and new message buffer (structured) serve complementary purposes — don't remove the ring buffer.
- Consider whether `handleTerminalWS` (single-terminal legacy endpoint) needs the same treatment. Likely not — it can be left as-is or deprecated since multi-terminal is the active path.
