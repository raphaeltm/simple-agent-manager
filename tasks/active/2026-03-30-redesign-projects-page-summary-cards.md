# Redesign /projects Page with ProjectSummaryCard

## Problem

The `/projects` page (`apps/web/src/pages/Projects.tsx`) renders bare-bones inline `<button>` cards showing only project name, repo@branch, and optional description. It uses the raw `Project` type from `listProjects()`.

Meanwhile, the Dashboard already uses a rich `ProjectSummaryCard` component with status badges, workspace/session counts, last activity time, and overflow menus — powered by the `useProjectList` hook returning `ProjectSummary[]`.

## Research Findings

- **`Projects.tsx`**: Uses `listProjects()` directly, manages its own loading/error/refresh state, sorts by `createdAt`, renders `<button>` cards in a single-column grid.
- **`Dashboard.tsx`**: Uses `useProjectList({ sort: 'last_activity', limit: 50 })` hook, renders `ProjectSummaryCard` in a responsive `grid-cols-1 md:grid-cols-2 lg:grid-cols-3` grid with `SkeletonCard` loading states.
- **`useProjectList` hook** (`hooks/useProjectData.ts`): Returns `{ projects, loading, isRefreshing, error, refresh }` with auto-polling (30s default). Accepts `sort`, `limit`, `status`, `pollInterval` options.
- **`ProjectSummaryCard`**: Accepts `{ project: ProjectSummary, onDelete?: (id: string) => void }`. Shows status badge, name, workspace/session counts, repo, last activity, and overflow menu with Edit/Delete actions.
- **`deleteProject`** is available from `api.ts`.

## Implementation Checklist

- [ ] Replace `listProjects` import with `useProjectList` hook from `hooks/useProjectData`
- [ ] Replace `Project` type import with `ProjectSummary` (already handled by hook)
- [ ] Remove manual `load`, `useState`, `useRef`, `useEffect`, `useMemo` state management (replaced by hook)
- [ ] Import `ProjectSummaryCard` from `components/ProjectSummaryCard`
- [ ] Import `SkeletonCard` from `@simple-agent-manager/ui` (replacing inline `Skeleton` usage)
- [ ] Add `deleteProject` import and implement `handleDelete` callback with `refresh`
- [ ] Replace single-column `grid gap-3` with responsive `grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4` layout
- [ ] Replace `<button>` cards with `<ProjectSummaryCard>` components
- [ ] Replace inline `Skeleton` loading state with `SkeletonCard` components matching Dashboard pattern
- [ ] Keep page layout (PageLayout title, description, New Project button, empty state)
- [ ] Remove unused imports (`Project`, `listProjects`, `Skeleton`, `useCallback`, `useEffect`, `useMemo`, `useRef`)

## Acceptance Criteria

- [ ] Projects page renders `ProjectSummaryCard` for each project
- [ ] Cards show status badge, name, workspace/session counts, repo, last activity
- [ ] Responsive grid layout matches Dashboard (1/2/3 columns)
- [ ] Loading state uses `SkeletonCard` matching Dashboard
- [ ] Delete action works via overflow menu
- [ ] Empty state and error handling preserved
- [ ] No new lint/typecheck errors
- [ ] Existing tests pass

## References

- `apps/web/src/pages/Projects.tsx`
- `apps/web/src/components/ProjectSummaryCard.tsx`
- `apps/web/src/pages/Dashboard.tsx`
- `apps/web/src/hooks/useProjectData.ts`
