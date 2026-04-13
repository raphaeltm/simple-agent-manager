# Promote Agent Profiles to Top-Level Project Navigation

## Problem

Agent profiles are currently buried at the bottom of the ProjectSettings page, making them hard to discover and manage. They should be a prominent, top-level navigation item within a project — with their own dedicated page.

Additionally, the nav item ordering needs adjustment: Activity should move down the list to just above Settings.

## Research Findings

### Current State

- **Nav items** defined in `apps/web/src/components/NavSidebar.tsx` lines 41-49:
  1. Chat, 2. Library, 3. Ideas, 4. Activity, 5. Notifications, 6. Triggers, 7. Settings
- **Profiles UI** lives in `apps/web/src/pages/ProjectSettings.tsx` lines 657-667, rendered as a `<ProfileList>` section
- **Profile components** already exist in `apps/web/src/components/agent-profiles/`:
  - `ProfileList.tsx` — card grid with create/edit/delete
  - `ProfileFormDialog.tsx` — modal form for create/edit
  - `ProfileSelector.tsx` — dropdown for selecting profiles
- **Hook** at `apps/web/src/hooks/useAgentProfiles.ts` handles CRUD
- **Routes** in `apps/web/src/App.tsx` lines 82-96 — no `profiles` route exists yet

### Desired State

New nav ordering:
1. Chat
2. Library
3. Ideas
4. Notifications
5. Triggers
6. **Profiles** (new — under Triggers)
7. **Activity** (moved down — just above Settings)
8. Settings

New dedicated `/projects/:id/profiles` page that renders the ProfileList with full CRUD capabilities.

## Implementation Checklist

- [ ] Create `apps/web/src/pages/ProjectProfiles.tsx` — dedicated profiles page using `useAgentProfiles` hook and existing `ProfileList` component
- [ ] Add route `profiles` under `/projects/:id` in `apps/web/src/App.tsx`
- [ ] Add "Profiles" nav item to `PROJECT_NAV_ITEMS` in `NavSidebar.tsx` (after Triggers, before Activity)
- [ ] Reorder nav: move Activity down to just above Settings
- [ ] Import a suitable icon for Profiles (e.g., `UserCog` or `Users` from lucide-react)
- [ ] Remove the Agent Profiles section from `ProjectSettings.tsx`
- [ ] Verify no broken links or references to profiles in settings
- [ ] Add/update tests for the new page and navigation changes

## Acceptance Criteria

- [ ] "Profiles" appears as a top-level nav item under Triggers
- [ ] Activity nav item is positioned just above Settings
- [ ] Clicking "Profiles" navigates to `/projects/:id/profiles`
- [ ] The profiles page shows the full profile list with create/edit/delete functionality
- [ ] The profiles section is removed from ProjectSettings
- [ ] No regressions in existing navigation or settings functionality
