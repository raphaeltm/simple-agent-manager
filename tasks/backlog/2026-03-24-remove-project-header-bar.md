# Remove Project Header Bar

## Problem

The non-chat project pages have a header bar at the top with the project title, a "Status" button (opens ProjectInfoPanel), and a "Settings" button (opens SettingsDrawer). This is clutter:
- The "Project Status" panel shows nonsensical information
- The settings sidebar doesn't bring value currently
- The title duplicates the PageLayout title area

## Research Findings

### Key Files
- `apps/web/src/pages/Project.tsx` — lines 125-167 contain the header bar in the non-chat route
- `apps/web/src/components/project/ProjectInfoPanel.tsx` — status panel component
- `apps/web/src/components/project/SettingsDrawer.tsx` — settings drawer component
- `apps/web/src/pages/ProjectContext.tsx` — context with settingsOpen/infoPanelOpen state

### Chat Route Still Uses These
- `ProjectChat.tsx` (lines 515, 524, 647) uses `setInfoPanelOpen` and `setSettingsOpen` from context
- The chat route in `Project.tsx` (lines 89-90) renders both SettingsDrawer and ProjectInfoPanel
- **Do NOT remove** the components or context values — chat still needs them

### Non-Chat Pages Don't Reference These
- No non-chat sub-page calls `setSettingsOpen` or `setInfoPanelOpen`
- Safe to remove drawers from non-chat layout since nothing can trigger them

## Implementation Checklist

- [ ] Remove the header bar div (lines 125-167) from non-chat route in `Project.tsx`
- [ ] Remove SettingsDrawer and ProjectInfoPanel from non-chat route (lines 173-174)
- [ ] Simplify the content wrapper div (gap/margin classes were for header+content spacing)
- [ ] Clean up unused imports if `useIsMobile` is no longer needed (check: still used for `compact={isMobile}`)
- [ ] Run lint, typecheck, tests to verify no breakage
- [ ] Verify existing tests still pass

## Acceptance Criteria

- [ ] Non-chat project pages no longer show the header bar with title, status button, settings button
- [ ] Chat page is unchanged — still has its own settings/status toggles
- [ ] No TypeScript errors, lint errors, or test failures
- [ ] Navigation between project pages works correctly

## References

- `apps/web/src/pages/Project.tsx`
- `apps/web/src/pages/ProjectChat.tsx`
- `apps/web/src/pages/ProjectContext.tsx`
