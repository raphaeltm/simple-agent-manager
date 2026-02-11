# Quickstart: PTY Session Persistence

**Feature**: 012-pty-session-persistence

## What This Feature Does

Terminal sessions survive page refreshes and brief network interruptions. When you refresh your browser or your connection drops momentarily, your running builds, test suites, and server processes keep running on the VM. When the browser reconnects, you're back exactly where you left off — same tabs, same output, same running processes.

## How It Works

1. **VM Agent** keeps PTY processes alive after your browser disconnects (default: until explicitly closed)
2. **Output buffer** captures terminal output while you're disconnected (last 256 KB)
3. **Browser** remembers your tab arrangement and session IDs in sessionStorage
4. **On reconnect**, the browser asks the server for active sessions, matches them against saved IDs, and reattaches

## Configuration

Two environment variables control persistence behavior on the VM Agent:

| Variable | Default | Description |
|----------|---------|-------------|
| `PTY_ORPHAN_GRACE_PERIOD` | `0` (disabled) | Seconds to keep orphaned sessions alive before auto-cleanup (`0` disables timer) |
| `PTY_OUTPUT_BUFFER_SIZE` | `262144` (256 KB) | Output buffer size per session in bytes |

Set these in `/etc/workspace/agent.env` on the VM or pass as environment variables to the VM Agent binary.

## User Experience

### Page Refresh
1. User refreshes the page
2. Tabs appear immediately with "Reconnecting..." overlay
3. Within ~2 seconds, terminals reconnect showing recent output
4. Running processes continue uninterrupted

### Network Interruption
1. Network drops briefly
2. Status bar shows "Reconnecting..."
3. Network recovers, terminals resume automatically
4. Missed output replayed on reconnect

### Browser Tab Close
1. User closes the browser tab entirely
2. Sessions remain alive on the VM by default until explicitly closed
3. If user returns later: sessions reattach
4. If `PTY_ORPHAN_GRACE_PERIOD` is set to a positive value, auto-cleanup runs after that delay

### VM Restart
1. VM Agent restarts (crash, update, etc.)
2. All PTY sessions are lost (in-memory only)
3. Browser reconnects, sees empty session list
4. Browser recreates tabs with saved names and order
5. User sees familiar tab arrangement with fresh terminals

## Testing

### Quick Smoke Test
1. Open a workspace with multi-terminal enabled
2. Create 2-3 terminal tabs
3. Run `sleep 300` in one tab, `watch date` in another
4. Refresh the page (F5 / Cmd+R)
5. Verify: Both tabs reappear, `sleep` still running, `watch` output visible

### Network Interruption Test
1. Open Chrome DevTools → Network tab
2. Toggle "Offline" mode for 5 seconds
3. Toggle back to online
4. Verify: Sessions reconnect, no output lost

### Grace Period Test
1. Note the current time
2. Close the browser tab entirely
3. Reopen the workspace URL after a few minutes
4. Verify: Sessions still reattach (default behavior)
5. Set `PTY_ORPHAN_GRACE_PERIOD=60`, restart VM Agent, and repeat
6. Verify: Fresh sessions created after the 60-second grace period expires

## Architecture Summary

```
Browser (React/TypeScript)          VM Agent (Go)
┌──────────────────────┐           ┌──────────────────────┐
│  sessionStorage      │           │  PTY Manager         │
│  ├─ tab names        │           │  ├─ sessions map     │
│  ├─ tab order        │           │  ├─ ring buffers     │
│  └─ session IDs  ◄───┼───match──►│  └─ orphan timers    │
│                      │           │                      │
│  MultiTerminal       │◄──WS────►│  WebSocket Handler   │
│  ├─ list_sessions    │           │  ├─ session_list     │
│  ├─ reattach_session │           │  ├─ session_reattached│
│  └─ create_session   │           │  ├─ scrollback       │
│                      │           │  └─ output (live)    │
└──────────────────────┘           └──────────────────────┘
```
