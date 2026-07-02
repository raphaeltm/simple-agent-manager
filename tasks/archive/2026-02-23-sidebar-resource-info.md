# Add CPU/Memory/Disk Info to Workspace Sidebar

**Created**: 2026-02-23
**Priority**: Medium
**Classification**: `ui-change`

## Context

The user wants CPU/Memory/Disk resource information displayed in the workspace sidebar, in a collapsible dropdown under workspace info (or as a separate "Resource Info" section). The data and infrastructure already exist — the Node detail page displays this via `SystemResourcesSection` + `useNodeSystemInfo` hook.

## Existing Infrastructure

### Data Types
- `packages/shared/src/types.ts:462-522` — `NodeSystemInfo` with cpu, memory, disk, network, uptime, docker, software, agent sections
- `packages/shared/src/types.ts:447-451` — `NodeMetrics` (lightweight: cpuLoadAvg1, memoryPercent, diskPercent)

### API
- `GET /api/nodes/:id/system-info` (`apps/api/src/routes/nodes.ts:354-372`) — proxies to VM Agent's `/system-info`
- Client function: `getNodeSystemInfo(nodeId)` in `apps/web/src/lib/api.ts`

### Hooks
- `apps/web/src/hooks/useNodeSystemInfo.ts` — polls every 10 seconds when node is running

### Reusable Components
- `apps/web/src/components/node/SystemResourcesSection.tsx` — displays CPU, Memory, Disk with percentage bars
- `apps/web/src/components/node/ResourceBar.tsx` — visual percentage bar component
- `apps/web/src/components/CollapsibleSection.tsx` — accordion wrapper used throughout sidebar

### Sidebar
- `apps/web/src/components/WorkspaceSidebar.tsx` — has `workspace.nodeId` available, uses `CollapsibleSection` for each section, uses `InfoRow` sub-component for key-value display

## Plan

Add a new "Node Resources" CollapsibleSection to the workspace sidebar that uses `useNodeSystemInfo` to poll resource data and displays compact CPU/Memory/Disk usage with percentage bars.

## Detailed Tasklist

- [x] Read `apps/web/src/components/WorkspaceSidebar.tsx` to understand current sections
- [x] Read `apps/web/src/components/node/SystemResourcesSection.tsx` for display patterns
- [x] Read `apps/web/src/hooks/useNodeSystemInfo.ts` for data fetching
- [x] Add `useNodeSystemInfo(workspace.nodeId, nodeStatus)` hook call to WorkspaceSidebar
- [x] Determine node status from workspace data (running if workspace is running)
- [x] Add new `CollapsibleSection` titled "Node Resources" (default collapsed)
- [x] Display compact CPU, Memory, Disk usage inside the section — reuse `ResourceBar` or create inline compact bars
- [x] Use `formatBytes()` helper for human-readable sizes
- [x] Handle loading and error states gracefully
- [x] Add `storageKey` to CollapsibleSection for localStorage persistence
- [x] Run build: `pnpm --filter @simple-agent-manager/web build`
- [x] Run typecheck: `pnpm typecheck`

## Files to Modify

| File | Change |
|------|--------|
| `apps/web/src/components/WorkspaceSidebar.tsx` | Add Node Resources section with system info |
