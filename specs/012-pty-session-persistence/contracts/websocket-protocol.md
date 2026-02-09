# WebSocket Protocol Contract: PTY Session Persistence

**Feature**: 012-pty-session-persistence
**Date**: 2026-02-09
**Endpoint**: `/terminal/ws/multi` (multi-terminal mode only)

## Overview

This document defines the WebSocket message protocol extensions for PTY session persistence. All new messages follow the existing `BaseMessage` format used by the multi-terminal WebSocket handler.

## Base Message Format

All messages are JSON-encoded text frames:

```json
{
  "type": "<message_type>",
  "sessionId": "<optional_session_id>",
  "data": { /* type-specific payload */ }
}
```

## New Client → Server Messages

### `list_sessions`

Request the server to send a list of all active (non-closed) PTY sessions.

**When sent**: Immediately after WebSocket connection is established on reconnect.

```json
{
  "type": "list_sessions"
}
```

**Response**: Server sends `session_list` message.

---

### `reattach_session`

Reattach to an existing orphaned PTY session instead of creating a new one.

**When sent**: After receiving `session_list`, for each session ID that matches browser-persisted metadata.

```json
{
  "type": "reattach_session",
  "data": {
    "sessionId": "uuid-of-existing-session",
    "rows": 24,
    "cols": 80
  }
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `sessionId` | `string` | Yes | ID of the session to reattach to |
| `rows` | `int` | Yes | Current terminal height |
| `cols` | `int` | Yes | Current terminal width |

**Success Response**: Server sends `session_reattached` followed by `scrollback`.
**Error Response**: Server sends `error` with details if session ID not found or session has exited.

---

## New Server → Client Messages

### `session_reattached`

Confirms successful reattachment to an existing PTY session.

```json
{
  "type": "session_reattached",
  "sessionId": "uuid-of-session",
  "data": {
    "sessionId": "uuid-of-session",
    "workingDirectory": "/workspaces/my-project",
    "shell": "/bin/bash"
  }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `sessionId` | `string` | Session that was reattached |
| `workingDirectory` | `string` | Current working directory (if available) |
| `shell` | `string` | Shell being used |

---

### `scrollback`

Buffered output replay sent immediately after `session_reattached`. Contains the ring buffer contents (up to 256 KB) captured while the session was orphaned.

```json
{
  "type": "scrollback",
  "sessionId": "uuid-of-session",
  "data": {
    "data": "<base64-or-utf8-encoded-terminal-output>"
  }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `sessionId` | `string` | Session the scrollback belongs to |
| `data` | `string` | Terminal output data (same encoding as `output` messages) |

**Notes**:
- Sent as a single message containing all buffered output
- Client should write this to xterm.js before processing subsequent `output` messages
- The `scrollback` message is sent exactly once per reattach, immediately after `session_reattached`
- After `scrollback`, live `output` messages resume normally

---

## Updated Existing Messages

### `session_list` (updated payload)

Response to `list_sessions` request. Now includes `status` field per session.

```json
{
  "type": "session_list",
  "data": {
    "sessions": [
      {
        "sessionId": "uuid-1",
        "name": "Terminal 1",
        "status": "running",
        "createdAt": "2026-02-09T12:00:00Z",
        "lastActivityAt": "2026-02-09T12:34:56Z",
        "workingDirectory": "/workspaces/my-project"
      },
      {
        "sessionId": "uuid-2",
        "name": "build",
        "status": "exited",
        "createdAt": "2026-02-09T12:00:00Z",
        "lastActivityAt": "2026-02-09T12:30:00Z"
      }
    ]
  }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `sessions[].sessionId` | `string` | Session identifier |
| `sessions[].name` | `string` | User-assigned tab name |
| `sessions[].status` | `string` | `"running"` or `"exited"` |
| `sessions[].createdAt` | `string` | ISO 8601 creation timestamp |
| `sessions[].lastActivityAt` | `string` | ISO 8601 last activity timestamp |
| `sessions[].workingDirectory` | `string` | Shell working directory (optional) |

**New `status` field values**:
- `"running"`: PTY process is alive, session can be reattached
- `"exited"`: PTY process has exited, session cannot be reattached (client should create fresh)

---

## Existing Messages (Unchanged)

These messages are not modified by this feature:

| Type | Direction | Description |
|------|-----------|-------------|
| `input` | C→S | Terminal keyboard input |
| `resize` | C→S | Terminal resize |
| `ping` / `pong` | C↔S | Keep-alive |
| `create_session` | C→S | Create new PTY session |
| `close_session` | C→S | Close PTY session |
| `rename_session` | C→S | Rename session tab |
| `output` | S→C | Live terminal output |
| `session_created` | S→C | Confirms new session |
| `session_closed` | S→C | Confirms session closure |
| `session_renamed` | S→C | Confirms rename |
| `error` | S→C | Error message |

---

## Reconnection Flow (Sequence)

```
Browser                                    VM Agent
   │                                          │
   │──── WebSocket Connect ──────────────────►│
   │                                          │
   │──── list_sessions ─────────────────────►│
   │                                          │
   │◄─── session_list ──────────────────────│
   │     [{id:"A",status:"running"},          │
   │      {id:"B",status:"exited"}]           │
   │                                          │
   │  (Browser matches A against              │
   │   sessionStorage, B is exited            │
   │   so create fresh for that tab)          │
   │                                          │
   │──── reattach_session {id:"A"} ─────────►│
   │                                          │  (cancel orphan timer for A)
   │◄─── session_reattached {id:"A"} ───────│
   │◄─── scrollback {id:"A", data:"..."} ───│
   │◄─── output {id:"A", data:"..."} ───────│  (live output resumes)
   │                                          │
   │──── create_session {id:"C"} ───────────►│  (fresh session for exited B's tab)
   │◄─── session_created {id:"C"} ──────────│
   │◄─── output {id:"C", data:"..."} ───────│
   │                                          │
```

## Error Cases

| Scenario | Server Response |
|----------|----------------|
| `reattach_session` with unknown session ID | `error: { error: "SESSION_NOT_FOUND", details: "Session {id} does not exist" }` |
| `reattach_session` for exited session | `error: { error: "SESSION_EXITED", details: "Session {id} has exited (code: N)" }` |
| `list_sessions` when no sessions exist | `session_list: { sessions: [] }` |
| `reattach_session` for already-attached session | Success (last-attach-wins; previous attachment detached) |
