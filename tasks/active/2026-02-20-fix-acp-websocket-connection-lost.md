# Fix ACP WebSocket "Connection Lost" Reliability

**Created**: 2026-02-20
**Status**: Active
**Branch**: `fix/acp-websocket-reliability`
**Priority**: High — all three parallel development sessions died from this bug

## Problem

ACP WebSocket connections silently die after periods of inactivity, showing "Connection lost" in the chat input. This happened to 3 concurrent sessions, making it the #1 reliability issue for the platform.

## Root Causes

1. **No browser-side heartbeat**: The terminal WebSocket has application-level JSON ping/pong, but the ACP WebSocket only used protocol-level WebSocket pings. Cloudflare and other proxies may not forward or count protocol-level pings as activity, causing idle timeout disconnections.

2. **Viewer write pump doesn't signal failure fast enough**: When `viewerWritePump` exits due to a write error, it closed the connection but didn't signal the `done` channel. The Gateway's read loop had to wait for the read deadline (40s) to expire before detecting the dead connection.

3. **Reconnect timeout too aggressive**: 30s total timeout with exponential backoff from 2s = only 3-4 reconnect attempts before giving up permanently.

## Solution

### Server-side (Go)

- [x] Add `MsgPing`/`MsgPong` control message types to `transport.go`
- [x] Handle JSON `{"type":"ping"}` in Gateway and respond with `{"type":"pong"}` via viewer send channel
- [x] Add `SendPongToViewer()` method on SessionHost
- [x] Add `Done()` method on Viewer to expose done channel
- [x] Fix `viewerWritePump` to close `viewer.done` BEFORE closing the connection (via `sync.Once`)
- [x] Rewrite Gateway `Run()` read loop to use goroutine + channel pattern for `select` on `viewerDone`, `ctx.Done()`, and read results simultaneously
- [x] Update `NewGateway` to accept `viewerDone` channel

### Client-side (TypeScript)

- [x] Add `PingMessage`/`PongMessage` to control message union in `types.ts`
- [x] Add `ping`/`pong` to `CONTROL_MESSAGE_TYPES` set
- [x] Implement client-side heartbeat in transport: send `{"type":"ping"}` every 30s
- [x] Track pong responses with timeout detection (10s deadline)
- [x] Force-close WebSocket on pong timeout to trigger reconnect path
- [x] Handle incoming `pong` messages (clear timeout timer)
- [x] Clean up heartbeat timers on close/destroy
- [x] Reduce initial reconnect delay from 2s to 1s for faster recovery
- [x] Increase total reconnect timeout from 30s to 60s (more attempts before giving up)

### Tests

- [x] Go: `transport_test.go` — ParseWebSocketMessage with ping/pong, pong marshalling
- [x] TypeScript: heartbeat interval, pong timeout, pong cancellation, disabled heartbeat, cleanup on close
