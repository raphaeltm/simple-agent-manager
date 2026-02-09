# Data Model: PTY Session Persistence

**Feature**: 012-pty-session-persistence
**Date**: 2026-02-09

## Entities

### PTY Session (Go: `pty.Session`)

The core entity representing a running pseudo-terminal process on the VM.

| Field | Type | Description | New? |
|-------|------|-------------|------|
| `ID` | `string` | Unique session identifier (UUID) | Existing |
| `UserID` | `string` | Owner user ID from JWT | Existing |
| `Cmd` | `*exec.Cmd` | Underlying shell/exec process | Existing |
| `Pty` | `*os.File` | PTY file descriptor | Existing |
| `Rows` | `int` | Current terminal height | Existing |
| `Cols` | `int` | Current terminal width | Existing |
| `CreatedAt` | `time.Time` | Session creation timestamp | Existing |
| `LastActive` | `time.Time` | Last I/O activity timestamp | Existing |
| `Name` | `string` | User-assigned tab name | New |
| `IsOrphaned` | `bool` | Whether session has no attached WebSocket | New |
| `OrphanedAt` | `time.Time` | When the session became orphaned | New |
| `ProcessExited` | `bool` | Whether the PTY process has exited naturally | New |
| `ExitCode` | `int` | Exit code if process exited | New |
| `OutputBuffer` | `*RingBuffer` | Circular buffer for recent output | New |
| `orphanTimer` | `*time.Timer` | Cleanup timer (unexported) | New |
| `attachedWriter` | `io.Writer` | Active WebSocket writer (nil when orphaned) | New |

**Lifecycle States:**

```
                    create_session
                         │
                         ▼
                    ┌──────────┐
                    │  Active  │◄──────── reattach_session
                    │(attached)│          (cancel orphan timer)
                    └────┬─────┘
                         │
              WebSocket disconnect
                         │
                         ▼
                    ┌──────────┐
              ┌─────│ Orphaned │
              │     │(buffering)│
              │     └────┬─────┘
              │          │
              │   grace period expires
              │          │
              │          ▼
              │     ┌──────────┐
              │     │  Closed  │
              │     │(cleaned) │
              │     └──────────┘
              │
        PTY process exits
              │
              ▼
        ┌───────────┐
        │  Orphaned  │
        │  (exited)  │──── grace period expires ──► Closed
        └───────────┘
```

**Validation Rules:**
- `ID` must be a valid UUID string
- `Name` max length: 50 characters
- `OutputBuffer` capacity: configurable, default 256 KB (262,144 bytes)
- Orphan timer duration: configurable, default 300 seconds
- A session cannot be reattached if `ProcessExited == true`

---

### Ring Buffer (Go: `pty.RingBuffer`)

Fixed-size circular buffer for capturing recent PTY output.

| Field | Type | Description |
|-------|------|-------------|
| `buf` | `[]byte` | Fixed-capacity backing array |
| `capacity` | `int` | Maximum buffer size in bytes |
| `writePos` | `int` | Current write position (wraps at capacity) |
| `written` | `int64` | Total bytes ever written (for overflow detection) |
| `mu` | `sync.Mutex` | Protects concurrent access |

**Operations:**

| Method | Description |
|--------|-------------|
| `NewRingBuffer(capacity int)` | Allocate buffer with given capacity |
| `Write(p []byte) (int, error)` | Append data, overwriting oldest if full |
| `ReadAll() []byte` | Return linearized copy of buffered data (tail-to-head) |
| `Len() int` | Current bytes stored (min of written, capacity) |
| `Reset()` | Clear buffer contents |

**Invariants:**
- `len(buf) == capacity` (allocated once, never resized)
- `Len() <= capacity`
- `ReadAll()` returns data in chronological order (oldest first)
- Thread-safe: `Write` and `ReadAll` acquire mutex

---

### Session Registry (Go: `pty.Manager`)

Extended fields on the existing PTY Manager.

| Field | Type | Description | New? |
|-------|------|-------------|------|
| `sessions` | `map[string]*Session` | All sessions (active + orphaned) | Existing |
| `gracePeriod` | `time.Duration` | Orphan cleanup delay | New |
| `bufferSize` | `int` | Output buffer capacity per session | New |

**New Operations:**

| Method | Description |
|--------|-------------|
| `OrphanSession(sessionID string)` | Mark session as orphaned, start cleanup timer |
| `OrphanSessions(sessionIDs []string)` | Batch orphan multiple sessions |
| `ReattachSession(sessionID string) (*Session, error)` | Cancel orphan timer, return session for reattach |
| `GetActiveSessions() []SessionInfo` | Return list of non-closed sessions with status |
| `SetSessionName(sessionID, name string)` | Store tab name on session |

---

### Session Info (Go: `pty.SessionInfo`)

Lightweight struct returned in session list responses.

| Field | Type | Description |
|-------|------|-------------|
| `ID` | `string` | Session identifier |
| `Name` | `string` | User-assigned tab name |
| `Status` | `string` | `"running"` or `"exited"` |
| `CreatedAt` | `time.Time` | Session creation timestamp |
| `LastActivityAt` | `time.Time` | Last I/O activity |
| `WorkingDirectory` | `string` | Shell working directory (if available) |

---

### Persisted Session (TypeScript: `PersistedSession`)

Browser-side sessionStorage schema.

| Field | Type | Description | New? |
|-------|------|-------------|------|
| `name` | `string` | Tab display name | Existing |
| `order` | `number` | Tab position (0-based) | Existing |
| `serverSessionId` | `string` | Server-assigned session ID for reattach matching | New |

**Persisted State Container:**

```typescript
interface PersistedState {
  sessions: PersistedSession[];
  counter: number;
}
```

**Storage Key:** `sam-terminal-sessions-{workspaceId}`

---

## Relationships

```
┌─────────────────┐       1:N        ┌──────────────┐
│  PTY Manager    │──────────────────│  PTY Session  │
│  (Registry)     │                  │               │
└─────────────────┘                  └───────┬───────┘
                                             │ 1:1
                                     ┌───────┴───────┐
                                     │  Ring Buffer   │
                                     │  (Output)      │
                                     └───────────────┘

┌─────────────────┐       1:N        ┌──────────────┐
│  WebSocket      │──────────────────│  Attached     │
│  Connection     │  (attachedWriter)│  Sessions     │
└─────────────────┘                  └──────────────┘

┌─────────────────┐       1:N        ┌──────────────────┐
│  sessionStorage │──────────────────│  PersistedSession │
│  (Browser)      │                  │  (Tab metadata)   │
└─────────────────┘                  └──────────────────┘
```

## Configuration (Environment Variables)

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `PTY_ORPHAN_GRACE_PERIOD` | `int` (seconds) | `300` | How long orphaned sessions survive before cleanup |
| `PTY_OUTPUT_BUFFER_SIZE` | `int` (bytes) | `262144` | Ring buffer capacity per session (256 KB) |
