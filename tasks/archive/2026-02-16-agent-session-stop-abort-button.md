# Agent Session Stop/Abort Button

**Created**: 2026-02-16
**Status**: Backlog
**Priority**: High
**Estimated Effort**: Small

## Context

Users currently have no way to stop or abort a running agent session from the UI. If the agent is mid-operation (e.g., running a long task, stuck in a loop, or doing something undesired), the only option is to close the browser tab entirely.

The backend infrastructure to stop an agent session **already exists end-to-end**:
- `POST /api/workspaces/:id/agent-sessions/:sessionId/stop` — control plane endpoint
- VM Agent `handleStopAgentSession()` — receives the stop request
- `SessionHost.Stop()` — kills the agent process, closes all viewer WebSocket connections

The only missing piece is the **UI button** to invoke it.

## Problem Statement

Users need an in-UI mechanism to stop/abort a running agent session without closing the tab. This is a basic usability requirement — every interactive agent interface needs a stop button.

## Proposed Solution

Add a **Stop button** to the AgentPanel toolbar that calls the existing stop API endpoint.

### UI Behavior

1. **Button placement**: In the AgentPanel header/toolbar, alongside existing controls
2. **Visibility**: Only shown when the agent is actively running (prompting state)
3. **On click**:
   - Call `POST /api/workspaces/:id/agent-sessions/:sessionId/stop`
   - Show "Stopping..." state with disabled button
   - Agent process is killed on the VM
   - WebSocket closes server-side (SessionHost broadcasts close to all viewers)
   - UI transitions to a "Session stopped" state
4. **After stop**: User can start a new session or reconnect

### What Already Exists (No Changes Needed)

- API endpoint: `apps/api/src/routes/workspaces.ts` — stop endpoint implemented
- Service layer: `apps/api/src/services/node-agent.ts` — `stopAgentSessionOnNode()`
- VM Agent: `packages/vm-agent/internal/server/workspaces.go` — handler implemented
- SessionHost: `packages/vm-agent/internal/acp/session_host.go` — `Stop()` method kills process and closes viewers
- API client: `apps/web/src/lib/api.ts` — `stopAgentSession()` likely available

### What Needs Implementation

- [ ] Add stop/abort button to `packages/acp-client/src/components/AgentPanel.tsx`
- [ ] Wire button to call `stopAgentSession()` API
- [ ] Handle loading/disabled state during stop
- [ ] Handle post-stop UI state (show "Session stopped" message)
- [ ] Ensure multi-viewer behavior is correct (stop from one tab stops all viewers)
- [ ] Add unit tests for the stop button component
- [ ] Verify mobile touch target (min 56px) per UI standards

### Design Considerations

- **Keyboard shortcut**: Consider `Ctrl+C` or `Escape` as keyboard shortcut (aligns with terminal conventions)
- **Confirmation**: No confirmation dialog needed — stopping is easily recoverable (start a new session)
- **Multi-viewer**: When one viewer stops, all viewers see the session end (this is existing SessionHost behavior)
- **In-flight prompt**: The stop kills the agent process mid-execution, which is the desired behavior for abort

## Technical Notes

- No new WebSocket message types needed — the HTTP API approach is cleaner than adding protocol-level abort
- No database schema changes needed
- No VM Agent changes needed — the handler already exists
- The stop endpoint uses best-effort VM Agent call with graceful fallback (if VM call fails, control plane state still transitions to `stopped`)

## Related Files

- `packages/acp-client/src/components/AgentPanel.tsx` — Main chat component (add button here)
- `packages/acp-client/src/hooks/useAcpSession.ts` — Session state hook
- `apps/web/src/components/ChatSession.tsx` — Wrapper component
- `apps/api/src/routes/workspaces.ts` — Stop endpoint (already implemented)
- `packages/vm-agent/internal/acp/session_host.go` — SessionHost.Stop() (already implemented)

## Success Criteria

- [ ] Stop button visible in AgentPanel when agent is active
- [ ] Clicking stop immediately terminates the agent session
- [ ] UI shows clear feedback during and after stopping
- [ ] Works on mobile (touch target requirements met)
- [ ] No orphaned agent processes after stop
- [ ] Unit tests pass for new UI component
