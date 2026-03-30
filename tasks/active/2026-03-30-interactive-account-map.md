# Interactive Account Map — Phase 1

## Problem Statement

SAM needs a visual "mission control" view showing all user entities (projects, nodes, workspaces, sessions, tasks, ideas) as an interactive node graph. This makes SAM's power as a control plane visible and tangible — users see their infrastructure, agents, conversations, and ideas connected in one glance.

Phase 1 delivers a static map with real data: new API endpoint, React Flow canvas, 6 custom node types, animated edges, search/filter, mobile responsiveness, and nav integration.

## Research Findings

### Key Integration Points
- **Router**: `apps/web/src/App.tsx` — add route inside `<Route element={<ProtectedLayout />}>` block (~line 106)
- **Nav**: `apps/web/src/components/NavSidebar.tsx` — add to `GLOBAL_NAV_ITEMS` array (~line 31)
- **API client**: `apps/web/src/lib/api.ts` — add `getAccountMap()` using `request<T>()` pattern
- **API route**: New `apps/api/src/routes/account-map.ts` — Hono router with `requireAuth()` + `requireApproved()`
- **AppShell layout**: Desktop = CSS Grid `220px 1fr`, main = `flex-1 overflow-y-auto`. Account Map page needs `h-full` to fill available space without PageLayout wrapper
- **Mobile hook**: `apps/web/src/hooks/useIsMobile.ts` — existing `useIsMobile()` hook (breakpoint 767px)
- **Design tokens**: `packages/ui/src/tokens/theme.css` — `--sam-color-*` variables, Tailwind utility classes

### API Pattern
- Hono route with `requireAuth()`, `requireApproved()` middleware
- `getUserId(c)` for ownership filtering
- `drizzle(c.env.DATABASE, { schema })` for D1 queries
- `projectDataService.*` for DO calls (sessions, tasks, ideas per project)
- `Promise.allSettled()` for fan-out to multiple DOs
- Optional KV caching with TTL

### Schema Tables
- `projects`: id, userId, name, repository, status, lastActivityAt, activeSessionCount
- `nodes`: id, userId, name, status, vmSize, vmLocation, cloudProvider, ipAddress, healthStatus, lastMetrics
- `workspaces`: id, nodeId, projectId, userId, displayName, branch, status, vmSize, chatSessionId
- `tasks`: id, projectId, userId, title, status, executionStep, workspaceId, priority

### Dependencies Needed
- `@xyflow/react` — React Flow for interactive node graph
- `dagre` — hierarchical auto-layout
- `@types/dagre` — TypeScript types for dagre

### No Prototype Available
The `demos/account-map/` directory referenced in the spec does not exist in the repo. Implementation will be built from the spec description directly.

## Implementation Checklist

### Phase A: Dependencies & Shared Types
- [ ] Add `@xyflow/react`, `dagre`, `@types/dagre` to `apps/web/package.json`
- [ ] Add `AccountMapResponse` types to `packages/shared/src/types/` (or inline in API route + client)

### Phase B: API Endpoint
- [ ] Create `apps/api/src/routes/account-map.ts` with `GET /` returning aggregated entity data
- [ ] Query D1 for projects, nodes, workspaces owned by user
- [ ] Fan out to ProjectData DOs for sessions, tasks, ideas per project
- [ ] Build relationship edges server-side
- [ ] Mount route at `/api/account-map` in `apps/api/src/index.ts`
- [ ] Add API integration test

### Phase C: React Flow Components
- [ ] Create `apps/web/src/components/account-map/` directory structure
- [ ] `nodes/ProjectNode.tsx` — large hub with completion ring, counts
- [ ] `nodes/NodeVMNode.tsx` — server card with metric bars, health dot
- [ ] `nodes/WorkspaceNode.tsx` — container card with branch name, status
- [ ] `nodes/SessionNode.tsx` — speech bubble with message count
- [ ] `nodes/TaskNode.tsx` — card with progress indicator, status label
- [ ] `nodes/IdeaNode.tsx` — lightbulb card with link count
- [ ] `edges/AnimatedFlowEdge.tsx` — SVG animateMotion particles with configurable color
- [ ] `layout/dagre-layout.ts` — dagre layout wrapper for auto-positioning
- [ ] `hooks/useAccountMapData.ts` — fetch + transform API data to React Flow nodes/edges
- [ ] `hooks/useMapFilters.ts` — filter chips + search state
- [ ] `AccountMapToolbar.tsx` — search input + filter chips + reorganize button
- [ ] `AccountMapCanvas.tsx` — ReactFlowProvider + ReactFlow with custom nodes/edges
- [ ] `AccountMapEmptyState.tsx` — empty state for new accounts

### Phase D: Page & App Integration
- [ ] Create `apps/web/src/pages/AccountMap.tsx` — full-screen page with loading/error/empty states
- [ ] Add route in `apps/web/src/App.tsx` protected routes block
- [ ] Add "Map" to `GLOBAL_NAV_ITEMS` in `NavSidebar.tsx` with Map icon
- [ ] Add `getAccountMap()` to `apps/web/src/lib/api.ts`

### Phase E: Mobile Responsiveness
- [ ] Stacked toolbar layout on mobile (search row + scrollable filter chips)
- [ ] Simplified node rendering on mobile (hide metric bars, truncate labels)
- [ ] Hide MiniMap and Controls on mobile
- [ ] Tap-for-tooltip instead of hover on mobile
- [ ] Touch drag and pinch zoom (React Flow native)

### Phase F: Tests
- [ ] API integration test for `GET /api/account-map`
- [ ] Component render tests for AccountMap page
- [ ] Playwright visual audit (mobile 375px + desktop 1280px)

## Acceptance Criteria
- [ ] Account Map page accessible from main nav sidebar
- [ ] All user-owned entities rendered as interactive nodes
- [ ] Animated particle edges on active connections
- [ ] Search highlights matching nodes, fades non-matching
- [ ] Filter chips toggle entity type visibility
- [ ] Nodes are draggable with auto-reorganize button
- [ ] Hover tooltips show entity details
- [ ] Works on mobile (375px+) with touch interactions
- [ ] Uses SAM design system tokens
- [ ] MiniMap on desktop, hidden on mobile
- [ ] Loading, error, and empty states handled
- [ ] API endpoint returns aggregated map data for authenticated user
- [ ] Playwright visual tests on mobile + desktop

## References
- Idea spec: `01KMZATY6YEGPNP91764VBR8TT`
- SAM task: `01KMZAVYZNP09T6K8R87009PQ1`
- Output branch: `sam/build-interactive-account-map-01kmza`
