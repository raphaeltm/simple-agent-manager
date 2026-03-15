# Show Agent Connection Errors in Project Chat

## Problem

When there's an error connecting to the agent, workspace chat shows a detailed error banner (red, with error code, message, suggested action, and reconnect button) via the `ErrorBanner` component in `AgentPanel`. However, project chat only shows a generic yellow "Agent offline" banner, hiding the actual error details from the user.

## Research Findings

### Workspace Chat (works correctly)
- `packages/acp-client/src/components/AgentPanel.tsx` renders `<ErrorBanner>` when `session.state === 'error'`
- `ErrorBanner` uses `getErrorMeta(session.errorCode)` to show structured error info:
  - User-facing message (e.g., "Network connection lost")
  - Detailed error string
  - Suggested action
  - Reconnect button (for recoverable errors)
  - Color coding: red for fatal/recoverable, yellow for transient

### Project Chat (the bug)
- `apps/web/src/components/chat/ProjectMessageView.tsx` lines 700-707
- Uses `useProjectAgentSession` hook which returns `session` (an `AcpSessionHandle` with `state`, `error`, `errorCode`)
- When agent is not active and not connecting, shows a generic banner:
  ```
  "Agent offline — messages will be saved but not processed until the agent reconnects."
  ```
- Does NOT differentiate between "offline" and "error with specific error code"
- Does NOT show error details, suggested actions, or reconnect button

### Shared Infrastructure
- `getErrorMeta` from `@simple-agent-manager/acp-client` already exported
- `AcpSessionHandle` type exported with `state`, `error`, `errorCode`, `reconnect()` properties
- Error taxonomy covers: network, auth, server, agent lifecycle, prompt, reconnection errors

## Implementation Checklist

- [x] Import `getErrorMeta` and `AcpSessionHandle` type from `@simple-agent-manager/acp-client`
- [x] Create `AgentErrorBanner` component in `ProjectMessageView.tsx` that:
  - Shows structured error details when `session.state === 'error'` (matching workspace chat behavior)
  - Falls back to generic "Agent offline" message when agent is just unreachable (not error state)
  - Uses design system classes (`bg-danger-tint`, `text-danger`, `bg-warning-tint`, `text-warning`)
  - Includes Reconnect button for recoverable errors
- [x] Replace inline generic banner with `<AgentErrorBanner>` component
- [ ] Verify typecheck and lint pass
- [ ] Run tests

## Acceptance Criteria

- [ ] When ACP session is in error state, project chat shows error message, error code details, and reconnect button (matching workspace chat behavior)
- [ ] When agent is simply offline (not error), project chat shows the existing generic "Agent offline" warning
- [ ] Transient errors show yellow banner; fatal/recoverable errors show red banner
- [ ] Reconnect button is shown for recoverable errors, hidden for fatal/transient
- [ ] No regressions in workspace chat error display

## References

- `packages/acp-client/src/components/AgentPanel.tsx` — `ErrorBanner` component (the reference implementation)
- `packages/acp-client/src/errors.ts` — Error taxonomy and `getErrorMeta`
- `apps/web/src/components/chat/ProjectMessageView.tsx` — The file being modified
- `apps/web/src/hooks/useProjectAgentSession.ts` — Hook providing ACP session state
