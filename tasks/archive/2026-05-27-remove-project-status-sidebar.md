# Remove Project Status Sidebar

## Problem
The "Project Status" sidebar (`ProjectInfoPanel`) that pops up when clicking the LayoutGrid icon at the top of the project chat list on desktop is useless. Remove it entirely.

## Research Findings
- **Component**: `apps/web/src/components/project/ProjectInfoPanel.tsx` — full slide-out panel with workspaces and recent tasks
- **Trigger button**: `apps/web/src/pages/project-chat/index.tsx:78-86` — LayoutGrid icon button calling `state.setInfoPanelOpen()`
- **State**: `infoPanelOpen` / `setInfoPanelOpen` in `ProjectContext` (defined in `ProjectContext.tsx`, wired in `Project.tsx`)
- **Renders**: Two `<ProjectInfoPanel>` in `Project.tsx` (lines 98 and 138) — one for chat routes, one for non-chat routes
- **Chat state hook**: `useProjectChatState.ts` destructures and re-exports `infoPanelOpen` / `setInfoPanelOpen`
- **Tests**: `apps/web/tests/unit/components/project/project-info-panel.test.tsx`
- **useScrollLock**: Used by 4 other components — NOT orphaned by this change

## Implementation Checklist
- [ ] Delete `apps/web/src/components/project/ProjectInfoPanel.tsx`
- [ ] Delete `apps/web/tests/unit/components/project/project-info-panel.test.tsx`
- [ ] Remove `infoPanelOpen` / `setInfoPanelOpen` from `ProjectContext.tsx` interface and context
- [ ] Remove `infoPanelOpen` state and context value from `Project.tsx`; remove `ProjectInfoPanel` import and renders
- [ ] Remove info panel button (LayoutGrid icon) from `project-chat/index.tsx`; clean up `LayoutGrid` import if unused
- [ ] Remove `infoPanelOpen` / `setInfoPanelOpen` from `useProjectChatState.ts`
- [ ] Fix any other test files that mock or reference `infoPanelOpen`

## Acceptance Criteria
- [ ] The LayoutGrid icon button is gone from the project chat header
- [ ] No "Project Status" panel appears anywhere in the app
- [ ] All related code, state, and tests are removed (no dead code)
- [ ] Typecheck, lint, and tests pass
