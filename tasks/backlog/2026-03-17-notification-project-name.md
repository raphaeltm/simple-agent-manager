# Fix: Notification Center shows project IDs instead of project names

## Problem

The NotificationCenter UI groups notifications by project, but displays truncated project IDs (e.g., "Project 01KHRJGA") instead of actual project names (e.g., "SAM"). This happens because:

1. Notification service functions (`notifyTaskComplete`, `notifyTaskFailed`, etc.) never include `projectName` in the notification metadata
2. The frontend falls back to `Project ${projectId.slice(0, 8)}` when `metadata.projectName` is missing
3. Neither the API route nor the DO enriches notifications with project names

## Research Findings

### Key Files
- **Notification service** (`apps/api/src/services/notification.ts`): 6 helper functions that create notifications — none include `projectName` in metadata
- **Notification DO** (`apps/api/src/durable-objects/notification.ts`): Stores and serves notifications; broadcasts via WebSocket. No D1 access, so cannot look up project names.
- **Notification routes** (`apps/api/src/routes/notifications.ts`): `GET /api/notifications` returns DO data directly without enrichment
- **NotificationCenter** (`apps/web/src/components/NotificationCenter.tsx`): Lines 124-126 — reads `metadata.projectName`, falls back to truncated ID
- **Existing test** (`apps/web/tests/unit/components/notification-grouping.test.tsx`): Tests already cover the `projectName` metadata path and the fallback — proving the UI is correct, just the data is missing

### Call Sites (all in `apps/api/src/routes/`)
- `tasks/crud.ts`: `notifySessionEnded`, `notifyPrCreated`, `notifyTaskComplete`, `notifyTaskFailed` — has D1 access
- `mcp.ts`: `notifyProgress`, `notifySessionEnded`, `notifyTaskComplete`, `notifyNeedsInput` — has D1 access

### Design Decision
**Include `projectName` in metadata at notification creation time** rather than enriching at API layer because:
- Covers both REST and WebSocket real-time delivery paths
- The DO cannot query D1 for project names, so WebSocket enrichment isn't possible
- TypeScript type enforcement prevents future omissions

## Implementation Checklist

- [ ] Add `projectName` to each notification service function's opts interface (required alongside `projectId`)
- [ ] Include `projectName` in metadata for every notification helper function
- [ ] Add `getProjectName` utility to look up project name from D1
- [ ] Update call sites in `tasks/crud.ts` to pass `projectName`
- [ ] Update call sites in `mcp.ts` to pass `projectName`
- [ ] Update existing unit test for grouping — verify no fallback-to-ID test regressions
- [ ] Add integration test that verifies `projectName` appears in notification metadata when created
- [ ] Run lint, typecheck, test, build

## Acceptance Criteria

- [ ] Notification group headers display actual project names, not IDs
- [ ] Both REST-fetched and WebSocket-delivered notifications include `projectName` in metadata
- [ ] Adding a new notification type without `projectName` causes a TypeScript error
- [ ] All existing notification tests pass
- [ ] New test verifies project name is included in notification metadata
