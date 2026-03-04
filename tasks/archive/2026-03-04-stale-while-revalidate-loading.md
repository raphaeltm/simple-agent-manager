# Stale-While-Revalidate Loading States

## Problem

Several pages in the web application show loading skeletons/spinners during background refetches (polling), which causes existing data to disappear briefly. Users may be about to interact with an element when it vanishes and reappears. Loading states should only show on initial load when no data exists. Subsequent fetches should keep existing data visible with a subtle refresh indicator.

## Research Findings

### Hooks that set `loading=true` on every refetch
- `apps/web/src/hooks/useAdminHealth.ts` — calls `setLoading(true)` at start of every 30s poll
- `apps/web/src/hooks/useNodeSystemInfo.ts` — calls `setLoading(true)` at start of every 10s poll
- `apps/web/src/pages/ProjectOverview.tsx` — calls `setWorkspacesLoading(true)` on every fetch
- `apps/web/src/pages/ProjectActivity.tsx` — calls `setActivityLoading(true)` on every fetch

### Components showing skeletons without checking if data already exists
- `apps/web/src/pages/Dashboard.tsx:52` — `tasksLoading ? <Skeletons>` (no data check)
- `apps/web/src/pages/Dashboard.tsx:86` — `projectsLoading ? <Skeletons>` (no data check)
- `apps/web/src/pages/Nodes.tsx:175` — `loading ? <Skeletons>` (no data check)
- `apps/web/src/pages/Node.tsx:240` — `loading ? <Skeletons>` (no data check)

### Components already correct (stale-while-revalidate pattern)
- `HealthOverview.tsx` — `loading && !health`
- `SystemResourcesSection.tsx` — `loading && !hasData`
- `DockerSection.tsx` — `loading && !docker`
- `SoftwareSection.tsx` — `loading && rows.length === 0`
- `TaskList.tsx` — `loading && tasks.length === 0`
- `ProjectOverview.tsx` — `workspacesLoading && workspaces.length === 0`

### Data fetching pattern
All hooks use vanilla `useState` + `useEffect` + `useCallback`. No React Query/SWR.

## Implementation Checklist

### Hook changes — add `isRefreshing` flag, stop resetting `loading` on refetch
- [ ] `useProjectList` — expose `isRefreshing` (loading starts true, never resets; isRefreshing true during polls)
- [ ] `useActiveTasks` — expose `isRefreshing`
- [ ] `useAdminHealth` — stop calling `setLoading(true)` on refetch; add `isRefreshing`
- [ ] `useNodeSystemInfo` — stop calling `setLoading(true)` on refetch; add `isRefreshing`

### Inline state changes in pages
- [ ] `Nodes.tsx` — add `isRefreshing` to its inline loadData pattern
- [ ] `Node.tsx` — add `isRefreshing` to its inline loadNode pattern
- [ ] `ProjectOverview.tsx` — stop setting `workspacesLoading=true` on refetch; add refreshing state
- [ ] `ProjectActivity.tsx` — stop setting `activityLoading=true` on refetch; add refreshing state

### Component rendering changes — show skeletons only when no data
- [ ] `Dashboard.tsx` — change to `tasksLoading && tasks.length === 0`, add refresh indicator
- [ ] `Dashboard.tsx` — change to `projectsLoading && projects.length === 0`, add refresh indicator
- [ ] `Nodes.tsx` — change to `loading && nodes.length === 0`, add refresh indicator
- [ ] `Node.tsx` — change to `loading && !node`, add refresh indicator
- [ ] `HealthOverview.tsx` — add subtle refresh indicator when loading && health exists
- [ ] `ProjectActivity.tsx` / `ActivityFeed.tsx` — keep data during refetch, add refresh indicator

### Testing
- [ ] Write behavioral tests for stale-while-revalidate pattern in key components
- [ ] Verify existing tests still pass

## Acceptance Criteria
- [ ] Loading skeletons only appear on initial load (when no data exists)
- [ ] Polling/refetch keeps existing data visible
- [ ] A subtle refresh indicator (small spinner) shows during background fetches
- [ ] All existing functionality preserved
- [ ] Typecheck, lint, and tests pass

## References
- Good existing pattern: `apps/web/src/components/admin/ErrorList.tsx` (shows data during pagination loading)
- Good existing pattern: `apps/web/src/components/node/SystemResourcesSection.tsx` (`loading && !hasData`)
