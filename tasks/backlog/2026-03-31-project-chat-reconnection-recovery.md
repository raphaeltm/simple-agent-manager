# Project Chat Reconnection Recovery

## Problem

Project chat sessions frequently show "Agent offline" (yellow banner) when the ACP WebSocket disconnects and fails to auto-recover. Users must navigate to the workspace view (where direct VM agent connection auto-resumes suspended sessions) and then return to project chat — a disruptive workaround. Additionally, the "Reconnecting..." banner with spinner shows on every brief DO WebSocket blip, creating visual noise for transient issues that self-heal.

## Root Cause Analysis

### Problem 1: ACP WebSocket gives up permanently

The ACP WebSocket reconnection has a 60-second total timeout (`DEFAULT_RECONNECT_TIMEOUT_MS = 60000` in `useAcpSession.ts`). After exhausting this timeout, the connection enters `error` state and stops retrying. Meanwhile:

- Server-side session is still `status: 'active'`, `isIdle: false` → `sessionState === 'active'`
- The auto-resume effect in `ProjectMessageView.tsx:697` only triggers when `sessionState === 'idle'`
- Result: permanent "Agent offline" banner with no automatic recovery

The workspace view doesn't have this problem because it connects directly to the VM agent (`ws-{id}.domain/agent/ws`), and the VM agent auto-resumes suspended sessions on WebSocket attach (`agent_ws.go:99`).

### Problem 2: Reconnecting banner shows on every blip

`ConnectionBanner` renders immediately when `connectionState !== 'connected'` (line 912). The DO WebSocket (`useChatWebSocket.ts`) transitions to `reconnecting` state on any close event. Brief network blips that self-heal in 1-2 seconds cause a visible banner flash.

## Research Findings

### Key Files
- `apps/web/src/components/chat/ProjectMessageView.tsx` — main chat view, auto-resume effect, banners
- `apps/web/src/hooks/useProjectAgentSession.ts` — ACP WebSocket hook for project chat
- `apps/web/src/hooks/useChatWebSocket.ts` — DO WebSocket hook with reconnection
- `packages/acp-client/src/hooks/useAcpSession.ts` — core ACP session state machine
- `packages/acp-client/src/transport/websocket.ts` — ACP WebSocket transport with heartbeat

### Prior Work
- PR #520: Added auto-resume for `idle` sessions (works correctly)
- PR #552: Added pong timeout detection to ACP WebSocket heartbeat
- PR #498: First implementation of auto-resume

### Existing Patterns
- `resumeAgentSession()` API call already exists and works for idle sessions
- `agentSession.reconnect()` method resets backoff and forces reconnection
- `hasAttemptedAutoResumeRef` prevents duplicate resume attempts per session

## Implementation Checklist

### Fix 1: ACP recovery when active but disconnected
- [ ] Add a recovery effect in `ProjectMessageView.tsx` that triggers when:
  - `sessionState === 'active'` (server thinks session is alive)
  - `agentSession.session.state === 'error'` (ACP gave up)
  - Not already resuming, not provisioning
- [ ] The recovery effect should:
  1. Wait a configurable delay (e.g., `VITE_ACP_RECOVERY_DELAY_MS`, default 5000ms) to avoid racing with ACP's own reconnection
  2. Call `resumeAgentSession()` to ensure the VM-side session is running
  3. Call `agentSession.reconnect()` to force a fresh ACP WebSocket connection
  4. Retry periodically (e.g., every 30s) if recovery fails, up to a max attempts limit
- [ ] Add configurable constants: `DEFAULT_ACP_RECOVERY_DELAY_MS`, `DEFAULT_ACP_RECOVERY_INTERVAL_MS`, `DEFAULT_ACP_RECOVERY_MAX_ATTEMPTS`
- [ ] Ensure the recovery ref resets when switching sessions (like `hasAttemptedAutoResumeRef`)

### Fix 2: Debounce the reconnecting banner
- [ ] Add a debounce delay before showing `ConnectionBanner` — only show after connection has been down for 3+ seconds
- [ ] Use a `useState` + `useEffect` pattern: track `connectionState` but delay the "show banner" state transition
- [ ] Configurable via `VITE_RECONNECT_BANNER_DELAY_MS` (default 3000ms)
- [ ] Ensure the banner still shows immediately for `disconnected` state (permanent failure)

### Tests
- [ ] Unit test: recovery effect triggers when sessionState='active' + ACP state='error'
- [ ] Unit test: recovery effect does NOT trigger when sessionState='idle' (existing auto-resume handles it)
- [ ] Unit test: recovery effect resets on session switch
- [ ] Unit test: reconnecting banner is debounced (not shown for brief disconnects)
- [ ] Unit test: reconnecting banner shows for sustained disconnects > threshold

### Documentation
- [ ] Update CLAUDE.md recent changes if needed

## Acceptance Criteria

- [ ] When ACP WebSocket disconnects and gives up while session is active, project chat automatically recovers without user intervention
- [ ] Brief DO WebSocket reconnections (< 3s) do not show the yellow "Reconnecting..." banner
- [ ] Sustained disconnections still show the banner after the debounce period
- [ ] Existing idle session auto-resume (PR #520) still works correctly
- [ ] All delay/interval/attempt values are configurable via environment variables (constitution Principle XI)
- [ ] No regressions in workspace view chat or other ACP session consumers

## References

- Prior auto-resume work: PR #520, PR #498
- ACP heartbeat: PR #552
- Auto-resume effect: `ProjectMessageView.tsx:697-743`
- ACP reconnection timeout: `useAcpSession.ts:11` (`DEFAULT_RECONNECT_TIMEOUT_MS = 60000`)
- VM agent auto-resume on attach: `agent_ws.go:99`
