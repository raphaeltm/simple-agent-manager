# Project Chat Header Revamp

## Problem

The project chat session header dropdown has several UX issues:
1. **Direct URL** is useless — takes space without adding value
2. **Branch name** is stuck in the status row; should be in the info section
3. **Location** without **provider** context is incomplete
4. **Node info link** exists but could be more prominent — the user needs quick access to the node page for manual workspace management
5. **No "Mark Complete" action** — users can't archive a task, delete its workspace, and stop the session in one action

## Research Findings

### Current UI Structure (`apps/web/src/components/chat/ProjectMessageView.tsx`)

**SessionHeader** component (line 879) renders:
- **Compact row** (always visible): session topic, workspace profile badge, state indicator, expand toggle
- **Expanded panel** with two sections:
  - **Status row**: idle countdown, branch name, PR link, "Open Workspace" button
  - **Infrastructure context** (ContextItem rows): Workspace link, VM Size, Location, Node link + health, Provider, **Direct URL** (to remove)

### Available Data
- `session`: has `workspaceId`, `id`, task info
- `taskEmbed`: has `outputBranch`, `outputPrUrl`, `id` (task ID)
- `workspace`: has `id`, `name`, `displayName`, `vmSize`, `vmLocation`, `url`, `status`
- `node`: has `id`, `name`, `healthStatus`, `cloudProvider`
- `projectId`: available in parent `ProjectMessageView` component (prop)

### API Functions Available (in `apps/web/src/lib/api.ts`)
- `updateProjectTaskStatus(projectId, taskId, { toStatus: 'completed' })` — marks task complete
- `deleteWorkspace(id)` — deletes workspace and associated resources
- `stopChatSession(projectId, sessionId)` — stops chat session (already called automatically by task completion handler on the API side)

### Task Completion Side Effects (API-side, `apps/api/src/routes/tasks/crud.ts:330-391`)
- When task status → `completed`: activity event recorded, chat session automatically stopped

### Key: No existing tests for SessionHeader

## Implementation Checklist

- [x] 1. Remove Direct URL section from SessionHeader
- [x] 2. Move branch name from status row to infrastructure context section (where Direct URL was)
- [x] 3. Reorder infrastructure context: Workspace, VM Size, Provider + Location (combined), Branch, Node link
- [x] 4. Keep "Open Workspace" button in the status/action row
- [x] 5. Add "Mark Complete" button in the action row area
- [x] 6. Implement `handleMarkComplete` function:
   - Confirm with user (window.confirm)
   - Call `updateProjectTaskStatus(projectId, taskId, { toStatus: 'completed' })` — also stops session server-side
   - Call `deleteWorkspace(workspaceId)` — full delete
   - Handle errors with alert, show loading state with spinner
   - Reload page after completion to reflect new state
- [x] 7. Thread `projectId` prop through to SessionHeader
- [x] 8. Add `GitBranch`, `CheckCircle2` icons from lucide-react
- [x] 9. Import `updateProjectTaskStatus`, `deleteWorkspace` in the component
- [x] 10. Add structural tests for the SessionHeader changes

## Acceptance Criteria

- [ ] Direct URL is removed from the expanded panel
- [ ] Branch name appears in the infrastructure context section
- [ ] Provider is displayed alongside location
- [ ] Node link is present and navigates to `/nodes/:id`
- [ ] "Mark Complete" button is visible in the action area when a task is associated
- [ ] Clicking "Mark Complete" prompts for confirmation, then completes the task, deletes the workspace, and updates UI
- [ ] Existing workspace/node links still work
- [ ] No regressions in the compact header row

## References

- `apps/web/src/components/chat/ProjectMessageView.tsx` — main component
- `apps/web/src/lib/api.ts` — API client functions
- `packages/shared/src/types.ts` — UpdateTaskStatusRequest, TaskStatus
- `apps/api/src/routes/tasks/crud.ts` — task status update handler (server-side session stop on completion)
