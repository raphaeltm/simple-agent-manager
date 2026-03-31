# Boot Log Drawer in Project Chat Provisioning

## Problem Statement

When a task is provisioning in the project chat view, users see "Setting up development environment..." but have no visibility into the actual devcontainer build/configure progress. The boot log streaming infrastructure already exists (VM agent reporter, WebSocket endpoint, React hook, KV fallback) — this is purely a frontend wiring task to surface those logs in the chat provisioning flow.

## Research Findings

### Existing Infrastructure
- **`useBootLogStream` hook** (`apps/web/src/hooks/useBootLogStream.ts`): Manages WebSocket connection to `/boot-log/ws`, returns `{ logs, connected }`. Requires `workspaceId`, `workspaceUrl`, and `status === 'creating'`.
- **`BootLogEntry` type** (`packages/shared/src/types.ts:949`): `{ step, status, message, detail?, timestamp }`
- **`BootProgress` component** (`apps/web/src/pages/Workspace.tsx:2192-2275`): Renders boot log entries with status icons (spinner/check/x), deduplicates by step, shows error detail for failed steps.
- **`ChatFilePanel` drawer** (`apps/web/src/components/chat/ChatFilePanel.tsx:237-256`): Slide-over pattern with backdrop, Escape to close, full-screen on mobile, `md:w-[min(560px,50vw)]` on desktop.

### Task Polling Response
- `getProjectTask()` returns `TaskDetailResponse` which extends `Task` — includes `workspaceId: string | null` but NOT `workspaceUrl`.
- `getWorkspace(id)` returns `WorkspaceResponse` with `url` and `bootLogs` fields.
- During provisioning poll (~line 438), `task.workspaceId` becomes available at `workspace_ready` step.

### ProvisioningState Type
- Currently at `ProjectChat.tsx:74-82`: `{ taskId, sessionId, branchName, status, executionStep, errorMessage, startedAt }`
- Needs `workspaceId` and `workspaceUrl` added.

### ProvisioningIndicator Component
- At `ProjectChat.tsx:1217-1281`: Shows progress bar with step labels and elapsed time.
- "View Logs" button should appear here when boot logs are available.

## Implementation Checklist

- [ ] 1. Extend `ProvisioningState` type — add `workspaceId: string | null` and `workspaceUrl: string | null`
- [ ] 2. Update task poll effect — when `task.workspaceId` is set, fetch workspace to get URL, store both in provisioning state
- [ ] 3. Update provisioning restore effect — also fetch workspace URL when restoring from session
- [ ] 4. Extract `BootProgress` to shared component — `apps/web/src/components/shared/BootLogList.tsx`
- [ ] 5. Update `Workspace.tsx` import — use extracted `BootLogList` instead of local `BootProgress`
- [ ] 6. Wire `useBootLogStream` in `ProjectChat.tsx` — call with provisioning workspace info
- [ ] 7. Create `BootLogPanel` slide-over — `apps/web/src/components/chat/BootLogPanel.tsx`
- [ ] 8. Add "View Logs" button to `ProvisioningIndicator` — show when `bootLogs.length > 0`
- [ ] 9. Add boot log panel state management in `ProjectChat.tsx` — open/close state, auto-close on provisioning complete
- [ ] 10. Verify Workspace page still works unchanged after extraction
- [ ] 11. Run lint, typecheck, build

## Acceptance Criteria

- [ ] "View Logs" button visible in provisioning banner when boot logs are streaming
- [ ] Clicking opens right-side drawer (full screen on mobile) with real-time log entries
- [ ] Each step shows status icon (spinner/check/x) and message
- [ ] Failed steps show error detail
- [ ] Panel auto-scrolls to latest entry
- [ ] Escape key and backdrop click close the panel
- [ ] Panel closes when provisioning completes
- [ ] `BootProgress` extracted to shared component; Workspace page still works unchanged
- [ ] No backend changes

## References

- `apps/web/src/hooks/useBootLogStream.ts`
- `apps/web/src/pages/ProjectChat.tsx:74-82` (ProvisioningState)
- `apps/web/src/pages/ProjectChat.tsx:1217-1281` (ProvisioningIndicator)
- `apps/web/src/pages/Workspace.tsx:2192-2275` (BootProgress)
- `apps/web/src/components/chat/ChatFilePanel.tsx:237-256` (drawer pattern)
- `packages/shared/src/types.ts:949` (BootLogEntry)
