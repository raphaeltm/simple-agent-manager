# Orphaned Session Detection & Recovery UX

**Created**: 2026-02-20
**Priority**: High
**Tags**: ux, reliability, sessions, acp, agent-lifecycle

## Problem Statement

Agent/ACP sessions can become "orphaned" — the agent process is still running on the VM, but the session is no longer visible in the UI sidebar or tab bar. The user has no way to discover these sessions, reconnect to them, or kill them. They silently consume resources and can cause confusion when the user creates a new session expecting a clean slate.

### Observed Symptoms

- Session disappears from the sidebar/tabs but the process remains on the VM
- No indication to the user that orphaned sessions exist
- No way to reconnect to or terminate an orphaned session from the UI
- Agent processes accumulate on the VM with no cleanup path

## Root Cause Analysis

Sessions can become orphaned through several distinct failure modes:

### A. Client-Side State Loss (localStorage cleared)

- Tab ordering is persisted to `localStorage` with key `sam-tab-order-{workspaceId}`
- If the user clears browser data, switches browsers, or opens from a different device, the client loses all session IDs
- The sessions are still listed by `GET /api/workspaces/{id}/agent-sessions` (DB records exist) but the tab strip doesn't render them
- SessionHost on the VM is still alive with the agent process running

### B. DB Says Stopped, VM Says Running

- User clicks "Stop Session" → DB updated to `status: stopped` immediately
- But the RPC call to the VM Agent to actually stop the SessionHost can fail (network timeout, node unhealthy)
- UI hides the session (it's "stopped") but the agent process is still running on the VM
- No reconciliation mechanism exists

### C. Stuck Prompt (Process Deadlock)

- `HandlePrompt()` calls `acpConn.Prompt(ctx)` with no hard timeout
- If the agent subprocess hangs, the prompt call blocks forever
- `promptMu` remains locked, session is stuck in `prompting` status
- Viewers that attach see a permanently-prompting session they can't interact with

### D. Token Expiry During Reconnect

- WebSocket token is fetched once on mount and baked into the URL
- Token expires (1 hour), but reconnect attempts reuse the same expired URL
- Reconnection fails repeatedly until the 60s timeout, then the session enters error state
- The agent process is still running on the VM

### E. Silent LoadSession Fallback

- When reconnecting, if `LoadSession()` fails, it silently falls back to `NewSession()`
- The previous ACP session is orphaned (process may still be running)
- User sees old chat history from the replay buffer but the underlying session is fresh

### F. Viewer Send Buffer Overflow

- During large replays (up to 5000 messages), viewer channel can fill (256 buffer)
- Control messages like `session_prompt_done` can be silently dropped
- Browser gets stuck in `prompting` state forever, user abandons the tab
- Session process continues running

## Current State

### What Exists

- **DB session records**: `GET /api/workspaces/{id}/agent-sessions` returns all sessions with status (running/stopped/error)
- **Live VM session list**: `GET /api/workspaces/{workspaceId}/sessions` on the VM Agent returns real-time SessionHost state
- **Tab order hook**: `useTabOrder.ts` manages localStorage-persisted tab positions with auto-pruning of stale IDs
- **Session stop API**: `POST /api/workspaces/{id}/agent-sessions/{sessionId}/stop` exists

### What's Missing

- **No reconciliation between DB state and VM state** — they can disagree
- **No "orphan detection"** — UI never compares "sessions I'm showing" vs "sessions that actually exist"
- **No session recovery UI** — if a session drops out of the tab bar, there's no way to get it back
- **No bulk cleanup** — no way to "stop all orphaned sessions" or "stop all sessions on this workspace"

## Proposed Solution

### Phase 1: Orphan Detection & Surfacing

- [ ] Add a "session reconciliation" check that runs when the workspace page loads
  - Compare sessions visible in the tab bar vs sessions returned by the API (both DB and live VM)
  - Identify orphaned sessions: running on server but not shown in UI
- [ ] Surface orphaned sessions in the UI
  - Options to evaluate:
    - **(a) Banner/toast notification**: "2 sessions are running but not shown. [View] [Stop All]"
    - **(b) Sidebar section**: Persistent "Orphaned Sessions" section below the active tab list
    - **(c) Session manager modal**: Accessible from workspace header, shows all sessions (active + orphaned) with controls
  - The chosen approach should support both reconnecting and killing orphaned sessions
- [ ] Design the UX for the orphaned session list item:
  - Show session label, agent type, status (running/prompting/error), uptime, last activity time
  - Actions: "Reconnect" (add back to tab bar), "Stop" (kill the process), "Delete" (stop + remove DB record)

### Phase 2: Recovery Actions

- [ ] Implement "Reconnect" action: re-adds the session to the tab bar and opens a WebSocket connection
  - Re-inserts session ID into localStorage tab order
  - Attaches viewer to existing SessionHost
  - Replays buffered messages
- [ ] Implement "Stop" action: sends stop RPC to VM Agent AND updates DB status
  - Must handle the case where VM Agent is unreachable (mark as "stop pending" and retry)
- [ ] Implement "Stop All Orphaned" bulk action
- [ ] Add confirmation dialogs for destructive actions (stop/delete)

### Phase 3: State Reconciliation

- [ ] Add periodic reconciliation (e.g., on workspace page focus/visibility change)
  - Re-check live VM sessions vs displayed sessions
  - Update session statuses from VM Agent truth (not just DB)
- [ ] Fix DB/VM state divergence for stop operations:
  - Only mark DB as `stopped` after VM Agent confirms the stop succeeded
  - Or add a reconciliation job that syncs DB state with VM reality
- [ ] Handle node-unreachable case: if VM Agent is down, show sessions as "unknown" status rather than hiding them

### Phase 4: Prevention (Reduce Orphaning)

- [ ] Refresh WebSocket token on each reconnect attempt (don't reuse stale cached token)
- [ ] Add hard timeout to `HandlePrompt()` in SessionHost (prevent infinite hangs)
- [ ] Surface LoadSession fallback to the user (toast: "Previous session couldn't be restored, starting fresh")
- [ ] Prioritize control messages in viewer send buffer to prevent `session_prompt_done` drops

## Key Code Locations

| Component | File | Relevance |
|-----------|------|-----------|
| Tab rendering | `apps/web/src/pages/Workspace.tsx` | Where sessions are displayed, where orphan detection should hook in |
| Tab order storage | `apps/web/src/hooks/useTabOrder.ts` | localStorage persistence, stale ID pruning |
| Session list API | `apps/api/src/routes/workspaces.ts:836-858` | DB-backed session listing |
| Live session list | `apps/web/src/lib/api.ts:490-505` | VM Agent direct session listing |
| SessionHost lifecycle | `packages/vm-agent/internal/acp/session_host.go` | Agent process ownership, viewer attach/detach |
| Session manager (VM) | `packages/vm-agent/internal/agentsessions/manager.go` | VM-side session registry |
| Session hook | `packages/acp-client/src/hooks/useAcpSession.ts` | Connection state machine, reconnect logic |
| Chat session | `apps/web/src/components/ChatSession.tsx` | WebSocket URL construction, token handling |
| Gateway relay | `packages/vm-agent/internal/acp/gateway.go` | WebSocket relay, viewer management |

## UX Questions to Resolve

1. **Where should orphaned sessions be surfaced?** Banner vs sidebar section vs modal — tradeoff between discoverability and clutter
2. **Auto-stop policy?** Should sessions with 0 viewers for >N minutes be auto-stopped? Or always require manual action?
3. **Cross-device sessions**: If a user opens the workspace from device B, should they see device A's sessions? (They should — the DB has them, but localStorage won't)
4. **Session age limit**: Should there be a maximum session lifetime after which it's force-stopped?

## Success Criteria

1. When orphaned sessions exist, the user is clearly informed
2. Users can reconnect to any orphaned session and resume where they left off
3. Users can stop/delete orphaned sessions individually or in bulk
4. DB and VM state are eventually consistent (no permanent divergence)
5. The UX is non-intrusive — doesn't clutter the workspace for users who have no orphaned sessions

## Dependencies

- Depends on the error taxonomy from PR #129 (now merged) for structured error codes in session status
- No external dependencies

## Risks

- Reconciliation polling could add unnecessary API load — needs to be event-driven or throttled
- Reconnecting to a long-orphaned session may surface stale/confusing state — need clear UX for "this session has been idle for X time"
- Auto-stop policies could kill sessions users intended to keep running (e.g., long-running agent tasks)
