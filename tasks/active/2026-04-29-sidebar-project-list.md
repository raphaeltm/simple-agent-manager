# Filterable Project List in Mobile Sidebar

## Problem

Raphaël primarily uses SAM on mobile. The mobile sidebar (MobileNavDrawer) has nav items and an Infrastructure section, but no quick way to switch between projects. Users must close the drawer, go to the Projects page, find their project, and navigate. This adds friction to the primary mobile workflow.

## Goal

Add a filterable, activity-sorted project list in the mobile sidebar (and desktop NavSidebar), placed below the Infrastructure section. Projects are ordered by most recent activity. A small search/filter input lets users quickly find a project by name.

## Research Findings

1. **MobileNavDrawer** (`apps/web/src/components/MobileNavDrawer.tsx`): Renders nav items + optional Infrastructure collapsible. Has two panels (project nav / global nav) with slide transition. The project list should appear in **both** the default (non-project) view and the global nav panel (when toggled from project context).
2. **NavSidebar** (`apps/web/src/components/NavSidebar.tsx`): Desktop sidebar with same structure — Infrastructure collapsible at bottom. Project list should appear here too.
3. **API**: `listProjects(limit)` already fetches projects. The API defaults to `sort=last_activity`. Returns `Project[]` with `name`, `id`, `updatedAt`. The `useProjectList` hook in `useProjectData.ts` wraps this with polling.
4. **ProjectSummary** type has `lastActivityAt`, `activeSessionCount`, `taskCountsByStatus` — useful for showing activity indicators.
5. **Design tokens**: Dark theme with green accent (`--sam-color-accent-primary: #16a34a`), surface hover (`--sam-color-bg-surface-hover: #1a2e29`).
6. **Knowledge directive**: Raphaël is mobile-first, skeptical of useEffect, prefers minimal useEffect usage.

## Implementation Checklist

- [ ] Create `SidebarProjectList` component with filter input + project list
- [ ] Fetch projects via `useProjectList` hook (limit ~20, sort by last_activity)
- [ ] Add filter input that filters by project name (client-side fuzzy/substring match)
- [ ] Show project name + activity indicator (relative time or active session dot)
- [ ] Clicking a project navigates to `/projects/:id/chat`
- [ ] Integrate into `MobileNavDrawer` — below Infrastructure in both default and global panels
- [ ] Integrate into `NavSidebar` — below Infrastructure in both project-context global panel and standalone global nav
- [ ] Collapsible section (like Infrastructure) with "Projects" header, default open
- [ ] Style consistent with existing sidebar items (same spacing, font sizes, hover states)
- [ ] Handle empty state (no projects) gracefully
- [ ] Handle loading state with subtle skeleton/spinner
- [ ] Write unit tests for the component
- [ ] Playwright visual audit at mobile (375px) and desktop (1280px)

## Acceptance Criteria

- [ ] Mobile sidebar shows a "Projects" section below Infrastructure
- [ ] Projects are sorted by most recent activity (most recent first)
- [ ] Filter input narrows the list by project name
- [ ] Tapping a project navigates to its chat page and closes the drawer
- [ ] Desktop sidebar also shows the project list in the same position
- [ ] No horizontal overflow on mobile
- [ ] Component has unit tests covering rendering, filtering, navigation, and empty state
