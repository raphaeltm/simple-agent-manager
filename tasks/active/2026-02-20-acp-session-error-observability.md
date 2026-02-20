# ACP Session Error Observability & Reconnection Reliability

**Created**: 2026-02-20
**Priority**: High
**Tags**: observability, debugging, reliability, acp, websocket

## Problem Statement

ACP agent sessions frequently enter an error state with "Connection lost" shown in the chat input, but there is no way for users or operators to understand **why** the session disconnected or **what** the underlying failure was. The current error UX is a dead end — the user sees a generic message and a reconnect button, with no diagnostic information, no logs accessible from the UI, and no clear path to resolution.

This makes it impossible to:
1. Debug why sessions keep disconnecting
2. Distinguish between network issues, agent crashes, auth failures, and server errors
3. Improve reliability because failure modes are invisible
4. Help users self-serve when something goes wrong

## Current State Analysis

### What Exists (Working Well)

- **3-layer error reporting on VM Agent**: Boot log (startup events), error reporter (batch to CF Workers observability), event log (in-memory, UI-visible workspace events)
- **Client-side error reporter**: Batches browser errors to `POST /api/client-errors` → CF Workers observability
- **ACP lifecycle event logging**: Transport and session hook emit structured lifecycle events routed to client error reporter
- **Reconnection with exponential backoff**: Close code classification, 60s timeout, jitter, manual reconnect button
- **Heartbeat-based stale detection**: App-level ping/pong (30s interval, 10s timeout) proactively closes dead connections
- **SessionHost persistence**: Agent process survives browser disconnects, message replay buffer (5000 msgs) enables late-join

### What's Broken or Missing

#### A. User-Facing Error Visibility (Critical)

1. **Generic error messages**: User sees only "Connection lost" regardless of whether it was a network drop, agent crash, auth expiry, or server error. No error codes, no details, no suggestions.
2. **No session event log in UI**: Workspace events exist but aren't surfaced per-session. When a chat tab shows "error", there's no way to see what happened.
3. **No node/workspace logs accessible from UI**: Detailed logs exist in CF Workers observability and VM Agent local logs, but users/operators cannot access them without Cloudflare dashboard access.
4. **LoadSession fallback is silent**: If session restore fails and falls back to a fresh session, the user is not notified — they lose conversation history with no indication.

#### B. Error Reporting Gaps (High)

5. **WebSocket read/write errors not reported to control plane**: When Gateway connections fail (broken pipe, reset, timeout), errors are logged locally on the VM but never reach CF Workers observability.
6. **Viewer send buffer overflow is silent**: If a viewer's 256-message buffer fills (slow client), messages are dropped with no notification to the user or control plane.
7. **Replay timeout is silent**: If message replay takes >5s, it's aborted and the viewer misses buffered messages — no indication.
8. **Error reporter has no retry**: If batch HTTP POST to control plane fails, errors are permanently lost (fire-and-forget).
9. **Boot log send has no retry**: Startup events that fail to send are permanently lost.
10. **Container resolution failures**: When SessionHost can't find the workspace container, the error is only logged locally.

#### C. Reconnection Limitations (Medium)

11. **60-second hard timeout**: After 60s of failed reconnects, gives up permanently. No way to continue automatically. Insufficient for slow networks or server maintenance windows.
12. **Initial connection failure is terminal**: If first WebSocket connection never opens, no automatic retry — user must manually click reconnect.
13. **`immediate` strategy misnomer**: Close codes 1001/1006 are classified as "immediate" but still use exponential backoff — same as `backoff` strategy. The classification doesn't actually differentiate behavior.
14. **No offline detection**: Doesn't check `navigator.onLine` before attempting reconnect — wastes timeout budget on connections that can't succeed.
15. **Stale URL during reconnect**: WebSocket token (15s cache) can expire during reconnection window, causing reconnect attempts to use invalid URLs.
16. **No server-side reconnect coordination**: When a viewer reconnects, the server doesn't know whether the previous connection was cleanly closed — no connection migration protocol.

#### D. Diagnostic Tooling (Medium)

17. **No structured error taxonomy**: Errors are free-form strings. No error codes that could be used for alerting, dashboarding, or user-facing guidance.
18. **No per-session error timeline**: Events exist per-workspace but not per-session. Can't correlate "session X entered error state" with specific failures.
19. **No connection quality metrics**: No tracking of reconnect frequency, latency, message delivery success rate, or buffer utilization per session.
20. **Stderr truncation**: Agent crash stderr is truncated to 500 chars (4KB buffer). Verbose crash logs lose critical context.

## Proposed Work Items

### Phase 1: Error Taxonomy & Structured Logging

- [x] Define an `AcpErrorCode` enum/union covering all known failure modes (network drop, heartbeat timeout, auth expired, agent crash, agent install failed, prompt timeout, container not found, buffer overflow, replay timeout, etc.)
- [x] Map each error code to a user-facing message and a suggested action (e.g., "Agent crashed — try switching agents or restarting the workspace")
- [x] Update SessionHost, Gateway, and transport to use structured error codes instead of free-form strings
- [ ] Add error codes to lifecycle events and error reporter payloads (deferred — server-side Go changes needed)

### Phase 2: Per-Session Event Log

- [ ] Add a per-session event timeline on the VM Agent (extend existing workspace event log to support session-scoped events)
- [ ] Expose session events via API (e.g., `GET /workspaces/:id/agent-sessions/:sessionId/events`)
- [ ] Surface session event timeline in the UI (expandable panel or modal accessible from the error state)
- [ ] Include connection open/close, reconnect attempts, agent status changes, errors, and prompt lifecycle events

### Phase 3: Enhanced Error UX

- [x] Replace generic "Connection lost" with error-code-specific messages and suggested actions
- [ ] Show a "Session Log" button/link when session enters error state, opening the per-session event timeline
- [ ] Add a toast/banner for silent failures (LoadSession fallback, buffer overflow, replay timeout)
- [ ] Show reconnection progress (attempt count, time elapsed, next retry in X seconds)

### Phase 4: Reconnection Improvements

- [x] Implement `navigator.onLine` check before reconnect attempts (fail fast when offline)
- [x] Add online/offline event listeners to pause/resume reconnect timer
- [ ] Extend reconnect timeout for `1001` (server going away) — server maintenance can take longer than 60s
- [ ] Refresh WebSocket URL/token on each reconnect attempt (avoid stale cached tokens)
- [ ] Consider infinite retry with increasing backoff caps for certain close codes
- [ ] Add server-side connection migration: when viewer reconnects, server can transfer pending prompt results

### Phase 5: Operational Observability

- [ ] Add retry logic to VM Agent error reporter HTTP batch sends
- [ ] Surface aggregated session error metrics in node/workspace detail pages (reconnect rate, error frequency, common error codes)
- [ ] Add error code dashboarding (which errors are most common, trending up/down)
- [ ] Track and expose connection quality metrics (ping latency, reconnect count per session, message delivery rate)

## Key Code Locations

| Component | File | Relevant Code |
|-----------|------|---------------|
| WebSocket transport | `packages/acp-client/src/transport/websocket.ts` | Heartbeat, lifecycle events, close handling |
| Session hook | `packages/acp-client/src/hooks/useAcpSession.ts` | State machine, reconnect logic, close code classification |
| Agent UI panel | `packages/acp-client/src/components/AgentPanel.tsx` | Error/reconnecting banners, input placeholder |
| Chat session | `apps/web/src/components/ChatSession.tsx` | Lifecycle event → error reporter routing |
| SessionHost (Go) | `packages/vm-agent/internal/acp/session_host.go` | Agent lifecycle, crash detection, error broadcasting |
| Gateway (Go) | `packages/vm-agent/internal/acp/gateway.go` | WebSocket relay, viewer management, ping/pong |
| Error reporter (Go) | `packages/vm-agent/internal/errorreport/reporter.go` | Batch error reporting to control plane |
| Client error reporter | `apps/web/src/lib/error-reporter.ts` | Browser error batching to API |
| Transport types | `packages/acp-client/src/transport/types.ts` | Message types, lifecycle event interface |

## Success Criteria

1. When a session enters an error state, the user can see **why** (specific error code + message)
2. When a session enters an error state, the user can see **what happened** (per-session event timeline)
3. Session errors are reported to CF Workers observability with structured error codes (not free-form strings)
4. Reconnection handles offline/online transitions gracefully
5. Silent failures (buffer overflow, replay timeout, LoadSession fallback) are surfaced to the user
6. Operators can identify common failure patterns from aggregated error data

## Dependencies

- None (this is an observability/reliability improvement to existing infrastructure)

## Risks

- Adding more UI for errors could clutter the chat experience — design must be progressive disclosure (simple message → expandable detail)
- Structured error codes require coordination across Go (VM Agent) and TypeScript (client) — shared constants or generated types
- Per-session event storage on VM adds memory pressure — need bounded buffers with eviction
