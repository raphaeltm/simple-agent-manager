# ACP Session Resume Fails After Auto-Suspend

**Created**: 2026-02-26
**Priority**: High
**Scope**: apps/web, packages/vm-agent, apps/api

## Problem Statement

When a user has multiple ACP (Agent Control Protocol) chat tabs open in a workspace and switches focus to one tab, the other tabs lose their viewer. After 30 minutes of no viewers (`ACP_IDLE_SUSPEND_TIMEOUT`), the VM agent auto-suspends those sessions:

1. `SessionHost.autoSuspend()` fires when no viewers are attached and the session isn't prompting
2. The agent process is stopped, the SessionHost is removed from the `sessionHosts` map
3. The session status transitions to `suspended` in both the VM agent and D1
4. The next browser polling cycle picks up `status: 'suspended'` + no `hostStatus`
5. `isSessionActive()` returns false, and the **tab disappears** from the tab strip

The sessions do appear in the "Session History" section of the sidebar with a resume button. However, clicking resume fails:

### Resume Failure Sequence

1. User clicks "Resume" in session history
2. `handleResumeSession()` calls `resumeAgentSession()` (control plane API)
3. Control plane sets D1 status back to `running`, calls `resumeAgentSessionOnNode()` on VM agent
4. VM agent's `handleResumeAgentSession()` transitions in-memory status to `running` but **explicitly does NOT create a SessionHost** (comment: "we do NOT create a SessionHost here. The SessionHost will be created on-demand when a viewer connects via WebSocket")
5. Frontend calls `handleAttachSession()` which navigates to the session view
6. `ChatSession` component mounts and attempts to open a WebSocket to the VM agent
7. The WebSocket connection triggers SessionHost creation with `LoadSession` using the preserved `AcpSessionID`
8. **Something fails during this reconnection** — the user briefly sees the tab, then gets an error message (approximately "unable to reconnect"), and the tab closes again

### Likely Root Causes

The failure likely occurs in one of these areas:

**A. LoadSession fails on the ACP side**: The preserved `AcpSessionID` may no longer be valid. If the Claude Code agent process was killed during suspend, the ACP session state may not be recoverable. The `LoadSession` call to the agent would fail, and the SessionHost would enter an error state.

**B. Race condition in polling vs WebSocket**: The 5-second polling interval (`loadWorkspaceState`) could fire and see the session as `running` but with `hostStatus: 'error'` (if LoadSession failed). `isSessionActive()` returns false for `hostStatus: 'error'` when status is not `'running'`... but actually `status === 'running'` is checked first and returns true. So this may not be the issue.

**C. SessionHost enters error state rapidly**: After the WebSocket creates a SessionHost and LoadSession fails, `monitorProcessExit()` detects a rapid exit (< 5 seconds), sets `hostStatus` to `'error'`. The next polling cycle sees `status: 'running'` + `hostStatus: 'error'`. Since `isSessionActive()` returns true for `status === 'running'` regardless of hostStatus, the tab should stay. But the ChatSession component itself may show an error overlay and the session may get auto-stopped.

**D. The WebSocket itself fails to connect**: If the VM agent rejects the WebSocket upgrade for the resumed session (e.g., token issues, session not found in the expected state), the ChatSession component may trigger a stop/cleanup.

## Observed Behavior

1. Multiple ACP tabs open in a workspace
2. User works in one tab, others go idle
3. After ~30 minutes, idle tabs disappear from the tab strip (auto-suspend)
4. Sessions appear in sidebar "Session History"
5. Clicking "Resume" briefly shows the tab, then shows an error and closes the tab

## Expected Behavior

1. Either: Auto-suspended sessions should remain as dimmed/inactive tabs in the tab strip (not disappear entirely), with a click-to-resume interaction
2. Or: Resume from session history should reliably restore the session with conversation history intact
3. Error states during resume should be clearly communicated with retry options, not silent tab closure

## Investigation Steps

- [x] Add logging/error capture to the resume flow to identify the exact failure point
- [x] Check if `LoadSession` with the preserved `AcpSessionID` actually succeeds on the VM agent
- [x] Verify the ACP session state survives agent process termination during suspend
- [x] Check if the ChatSession WebSocket connection receives an error that triggers cleanup
- [x] Test whether the 5-second polling cycle interferes with the resume flow

## Root Causes Found

### 1. Process Stop Bug (Critical — causes memory leaks)
`AgentProcess.Stop()` sent SIGTERM/SIGKILL to the host-side `docker exec` process group,
but the `claude-code-acp` and `claude` processes run inside the container in a separate PID
namespace. Killing `docker exec` just breaks the pipe — container processes keep running and
consuming memory indefinitely.

**Fix**: Added `killContainerProcesses()` method that uses `docker exec <container> pkill -<signal> -f <agentType>` to kill processes inside the container before host-side signals.

### 2. Tab Disappearance (UX)
`isSessionActive()` returns false for `suspended` sessions (no `hostStatus`), so auto-suspended
tabs vanished entirely from the tab strip. Users had to find them in the sidebar session history.

**Fix**: Tab strip now includes suspended sessions as dimmed tabs (opacity 0.55, yellow status dot).
Clicking a suspended tab auto-triggers resume. Suspended sessions no longer appear in sidebar history.

### 3. Resume Fragility (Root cause of the reported bug)
The control plane resume API calls `resumeAgentSessionOnNode()` best-effort (swallows errors).
If this fails, the VM agent's in-memory session stays `suspended`. When the browser opens a
WebSocket, `handleAgentWS` checks `session.Status != StatusRunning` and rejects the connection
with "session_not_running".

**Fix**: Added auto-resume logic in `handleAgentWS` — if the session is `suspended` when a
WebSocket connects, it automatically calls `agentSessions.Resume()` to transition it to `running`
before proceeding with SessionHost creation.

## Key Code Paths

### Auto-Suspend Trigger
- `packages/vm-agent/internal/acp/session_host.go:126-180` — `DetachViewer()` starts idle timer, `autoSuspend()` fires after timeout
- `packages/vm-agent/internal/agentsessions/manager.go:118-145` — `Suspend()` state transition

### Resume Flow (Control Plane)
- `apps/api/src/routes/workspaces.ts:1106-1166` — `POST /:id/agent-sessions/:sessionId/resume`
- `apps/api/src/services/node-agent.ts` — `resumeAgentSessionOnNode()`

### Resume Flow (VM Agent)
- `packages/vm-agent/internal/server/workspaces.go:660-692` — `handleResumeAgentSession()` — transitions status but does NOT create SessionHost
- `packages/vm-agent/internal/agentsessions/manager.go:147-170` — `Resume()` state transition

### Resume Flow (Frontend)
- `apps/web/src/pages/Workspace.tsx:989-1003` — `handleResumeSession()` calls API then `handleAttachSession()`
- `apps/web/src/components/ChatSession.tsx` — mounts and opens WebSocket
- `apps/web/src/lib/session-utils.ts` — `isSessionActive()` determines tab visibility

### Tab Visibility
- `apps/web/src/pages/Workspace.tsx:1093-1094` — chat tabs filtered by `isSessionActive() && !recentlyStopped`
- `apps/web/src/pages/Workspace.tsx:290-307` — 5-second polling interval for session state

### Session History UI
- `apps/web/src/components/WorkspaceSidebar.tsx:573-670` — suspended/stopped session history with resume button

## Acceptance Criteria

1. Resuming an auto-suspended ACP session restores the tab with conversation history
2. If resume fails (e.g., ACP session expired), show a clear error with option to start a new session
3. The tab should not silently disappear — either stay with error state or show explicit feedback
4. Consider whether auto-suspended sessions should remain as dimmed tabs instead of disappearing entirely
