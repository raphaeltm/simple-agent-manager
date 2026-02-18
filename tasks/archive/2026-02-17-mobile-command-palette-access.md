# Mobile Command Palette Access

**Created**: 2026-02-17
**Size**: Small
**Area**: UI (`apps/web`)

## Problem

The command palette (Cmd+K) is keyboard-only — there's no way to trigger it on mobile devices. Mobile users miss out on quick file search, tab switching, and action discovery.

## Current State

| Element | Mobile | Desktop |
|---------|--------|---------|
| **Command palette** | No access (keyboard-only) | Cmd+K / Ctrl+K |
| **Header width used** | ~366px on 375px screen | Comfortable |
| **Icon buttons** | 44×44px touch targets, 18px icons | 32×32px, 16px icons |
| **Gap between items** | 4px | 10px |

### Mobile Header Layout (left to right)
1. Back button (44px)
2. Workspace name + status badge (~150px)
3. FileBrowserButton (44px)
4. GitChangesButton (44px)
5. MoreVertical menu (44px)
6. UserMenu (~40px)

**Total: ~366px — virtually no room for another 44px button.**

Key files:
- `apps/web/src/pages/Workspace.tsx` (L1076-1236) — header layout
- `apps/web/src/components/FileBrowserButton.tsx` — file browser button
- `apps/web/src/components/GitChangesButton.tsx` — git changes button

## Proposed Approach

Add a search/magnifying glass button to trigger the command palette on mobile. To make room, reduce icon button sizes on mobile rather than introducing a secondary bar (avoid layout complexity for now).

### Implementation Plan

- [ ] Add a `CommandPaletteButton` component (magnifying glass icon via lucide-react `Search`)
- [ ] Place it in the header next to FileBrowserButton and GitChangesButton
- [ ] Reduce mobile icon button touch targets from 44×44px to ~36×36px and icons from 18px to 16px for the utility group (file browser, git, search, mobile menu) — this recovers ~32px of space
- [ ] Alternatively, if 36px still feels too tight, move FileBrowser + Git + Search into a compact utility group with reduced spacing (2px gap instead of 4px)
- [ ] Wire the button's onClick to `setShowCommandPalette(true)` (same as Cmd+K handler)
- [ ] Button should be visible on mobile only (desktop users have Cmd+K)
- [ ] Ensure the command palette overlay works well on mobile (full-width, proper keyboard handling)
- [ ] Add unit tests for button visibility and command palette trigger

### Space Budget (after reducing to 36px targets)

| Element | Before | After |
|---------|--------|-------|
| Back button | 44px | 44px (keep — primary nav) |
| Name + badge | ~150px | ~150px |
| FileBrowser | 44px | 36px |
| GitChanges | 44px | 36px |
| **Search (new)** | — | 36px |
| MoreVertical | 44px | 36px |
| UserMenu | ~40px | ~40px |
| **Total** | ~366px | ~378px |

378px on a 375px screen is still tight. May need to:
- Trim workspace name max-width from 140px to ~120px, or
- Reduce gaps from 4px to 2px between utility buttons, or
- Hide the search button behind the MoreVertical menu as a fallback

The right tradeoff should be evaluated visually during implementation with Playwright mobile viewport screenshots.

## Design Notes

- Magnifying glass (`Search` icon) is a universally recognized pattern for "search / find"
- Could add a subtle placeholder hint in the command palette ("Search files, tabs, actions...")
- The command palette already supports file search, tab switching, and action execution — just needs a tap target

## Out of Scope

- Redesigning the header into a two-row layout (revisit if more buttons are needed later)
- Adding swipe gestures or other mobile-specific interactions
- Changing command palette functionality (this task is access only)
