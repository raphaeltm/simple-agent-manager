# Fix Agent Profiles Page Mobile Layout

## Problem

The agent profiles page (`ProjectProfiles.tsx` → `ProfileList.tsx`) breaks on mobile screens. Profile cards overflow horizontally, pushing content off the edge of the screen. Users cannot access edit/delete controls on their phone.

Raphaël discovered this while trying to edit a profile on his phone — the cards go off-screen and the edit button is unreachable.

## Root Cause

In `ProfileList.tsx`, each profile card uses `flex items-start gap-3` with:
- A `flex-1 min-w-0` content area (name, description, metadata tags)
- A `shrink-0` action button area (edit + delete buttons)

When the delete confirmation is active, it renders "Confirm" + "Cancel" buttons inline next to the edit button. On a 375px mobile screen, this is too wide. Additionally, long profile names, descriptions, and metadata tags compound the overflow.

## Research Findings

- **ProfileList.tsx** (lines 104-171): Card layout is `flex items-start gap-3 p-3` — horizontal only, no responsive stacking
- **Action buttons** (lines 132-169): `shrink-0` prevents them from shrinking; delete confirmation adds "Confirm" + "Cancel" buttons inline
- **Metadata tags** (lines 123-129): `flex flex-wrap` handles wrapping, but the parent flex container doesn't account for the total width on mobile
- **ProfileFormDialog.tsx**: The dialog form already uses `sm:grid-cols-2` for responsive layout — good pattern to follow
- **ProjectProfiles.tsx** (line 17): Container has `max-w-3xl mx-auto px-4 py-6` which is fine

## Implementation Checklist

- [x] Fix profile card layout (kept action buttons in header row with overflow-hidden; different approach than planned but works correctly)
- [x] Make delete confirmation buttons wrap to their own row on narrow screens
- [x] Ensure long profile names and descriptions truncate properly on mobile
- [x] Write Playwright visual audit test with mock data (normal, long text, many items, empty, error)
- [x] Capture before screenshots showing the broken layout
- [x] Implement the CSS/layout fix
- [x] Capture after screenshots confirming the fix
- [x] Verify no horizontal overflow at 375px mobile viewport

## Acceptance Criteria

- [x] Profile cards render fully within the viewport on a 375px-wide screen
- [x] Edit and delete buttons are accessible (tappable) on mobile
- [x] Delete confirmation buttons do not push content off-screen
- [x] Long profile names truncate cleanly without horizontal overflow
- [ ] Desktop layout (1280px) is unchanged or improved (desktop Playwright tests skipped — pre-existing infrastructure issue, filed as backlog task)
- [x] Playwright visual audit passes with no horizontal overflow at mobile viewports (desktop skipped — see above)

## References

- `apps/web/src/pages/ProjectProfiles.tsx`
- `apps/web/src/components/agent-profiles/ProfileList.tsx`
- `.claude/rules/17-ui-visual-testing.md`
