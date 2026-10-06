# Remove Project Settings Drawer

## Problem

The project chat has a settings sidebar/drawer (`SettingsDrawer`) that slides in when you click the gear icon at the top of the project chat list on desktop. This duplicates functionality available on the full project settings page (`/projects/:id/settings`) and creates potential for UI drift between the two surfaces.

The user wants to remove the drawer entirely and have the gear icon navigate to the full project settings page instead.

## Research Findings

- `SettingsDrawer` component: `apps/web/src/components/project/SettingsDrawer.tsx` (683 lines)
- Used in `apps/web/src/pages/Project.tsx` (lines 97, 137) — rendered in both chat and non-chat layouts
- Gear icon trigger: `apps/web/src/pages/project-chat/index.tsx` (lines 92-100 desktop, lines 205-212 mobile)
- State lives in `ProjectContext` (`settingsOpen`, `setSettingsOpen`)
- `useProjectChatState` destructures and re-exports `settingsOpen`/`setSettingsOpen`
- Test file `apps/web/tests/unit/Project.test.tsx` mocks the `SettingsDrawer`

## Implementation Checklist

- [ ] Replace gear icon click handler in project-chat desktop sidebar to navigate to `/projects/:id/settings`
- [ ] Replace gear icon click handler in project-chat mobile header to navigate to `/projects/:id/settings`
- [ ] Remove `SettingsDrawer` usage from `Project.tsx`
- [ ] Remove `settingsOpen`/`setSettingsOpen` from `ProjectContext` interface and provider
- [ ] Remove `settingsOpen`/`setSettingsOpen` from `useProjectChatState`
- [ ] Delete `SettingsDrawer.tsx`
- [ ] Update test file `Project.test.tsx` to remove SettingsDrawer mock
- [ ] Run typecheck, lint, and tests to verify clean removal

## Acceptance Criteria

- [ ] Gear icon in project chat navigates to the full project settings page
- [ ] No `SettingsDrawer` component exists in the codebase
- [ ] `settingsOpen`/`setSettingsOpen` removed from project context
- [ ] All tests pass
- [ ] No TypeScript errors
