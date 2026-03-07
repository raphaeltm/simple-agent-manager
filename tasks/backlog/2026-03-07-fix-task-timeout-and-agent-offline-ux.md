# Fix Task Execution Timeout & Agent Offline UX During Provisioning

## Problem

Two related UX issues when scheduling tasks with no existing nodes:

### 1. Task execution timeout too short (120 minutes)
Tasks that are legitimately running with an active agent get killed after 2 hours by the stuck-task recovery cron. Error: "Task failed: Task exceeded max execution time of 120 minutes. Last step: running (agent active)." Complex coding tasks can easily exceed 2 hours.

### 2. Misleading "Agent offline" banner during provisioning
When a workspace is still provisioning (node being created, agent starting up), the chat shows "Agent offline — messages will be saved but not processed until the agent reconnects." This implies the agent was previously online and disconnected, when in reality it was never online — the node is still being provisioned. The provisioning progress bar already indicates this state correctly.

## Research Findings

### Task Timeout
- **Default**: `DEFAULT_TASK_RUN_MAX_EXECUTION_MS = 2 * 60 * 60 * 1000` (2 hours) in `packages/shared/src/constants.ts:140`
- **Env var override**: `TASK_RUN_MAX_EXECUTION_MS` parsed in `apps/api/src/scheduled/stuck-tasks.ts:190`
- **Error generated**: `apps/api/src/scheduled/stuck-tasks.ts:237-245` in `recoverStuckTasks()`
- Separate from node ready timeout (120s → 600s in commit d93a39c)

### Agent Offline Banner
- **Rendered**: `apps/web/src/components/chat/ProjectMessageView.tsx:528-534`
- **Condition**: `sessionState === 'active' && connectionState === 'connected' && session?.workspaceId && !agentSession.isAgentActive && !agentSession.isConnecting`
- **Provisioning state**: Lives in `apps/web/src/pages/ProjectChat.tsx:116` — not passed to `ProjectMessageView`
- **Fix**: Pass `isProvisioning` prop to suppress the banner during active provisioning

## Implementation Checklist

- [ ] Increase `DEFAULT_TASK_RUN_MAX_EXECUTION_MS` from 2 hours to 4 hours in `packages/shared/src/constants.ts`
- [ ] Update the comment on `DEFAULT_TASK_STUCK_DELEGATED_TIMEOUT_MS` if needed
- [ ] Add `isProvisioning` prop to `ProjectMessageView` interface
- [ ] Pass provisioning state from `ProjectChat.tsx` to `ProjectMessageView`
- [ ] Guard the "agent offline" banner: suppress when `isProvisioning` is true
- [ ] Update `.env.example` comment to reflect new default
- [ ] Add/update tests for the agent offline banner suppression
- [ ] Run typecheck, lint, test, build

## Acceptance Criteria

- [ ] Default task execution timeout is 4 hours (240 minutes)
- [ ] "Agent offline" banner does NOT show while workspace is provisioning
- [ ] "Agent offline" banner DOES show when agent genuinely disconnects after being online
- [ ] All existing tests pass
- [ ] New behavioral test covers the provisioning suppression logic

## References

- `packages/shared/src/constants.ts` — timeout constants
- `apps/api/src/scheduled/stuck-tasks.ts` — stuck task recovery
- `apps/web/src/components/chat/ProjectMessageView.tsx` — offline banner
- `apps/web/src/pages/ProjectChat.tsx` — provisioning state
- `apps/web/src/hooks/useProjectAgentSession.ts` — agent connection state
