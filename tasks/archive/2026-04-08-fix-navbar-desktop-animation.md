# Fix Navbar Desktop Animation Overflow

## Problem

The nav toggle animation between project nav and global nav is broken on desktop. When clicking "Back to Projects" to show the global nav, the project nav panel text bleeds through at the left edge of the sidebar.

**Root cause**: The sliding container uses `translateX(-50%)` to shift panels. CSS `translateX` percentages are relative to the element's own width. The sliding flex container is constrained to 219px (sidebar width minus border) by its overflow-hidden parent, NOT 2× panel width as the code assumes. So `translateX(-50%)` = `translateX(-109.5px)` instead of the intended `translateX(-219px)`, producing only a half-shift.

**Evidence**: Playwright inspection on staging shows:
- `overflowDiv.width`: 219px
- `slidingDiv.width`: 219px (same as one panel, not 2×)
- `transform`: `translateX(-109.5px)` — only half the needed shift
- Each panel: 219px with `shrink-0`, overflowing the flex container

## Research Findings

- **NavSidebar.tsx:96** — Desktop: `translateX(-50%)` should be `translateX(-100%)`
- **MobileNavDrawer.tsx:163** — Mobile: Same `translateX(-50%)` pattern, same bug
- **Feature commit**: `ec97e749` (April 7, 2026) — "feat: smooth in-place nav toggle"
- **Existing tests**: `nav-toggle.test.tsx` (unit), `nav-toggle-audit.spec.ts` (Playwright visual)

## Implementation Checklist

- [ ] Change `translateX(-50%)` to `translateX(-100%)` in `NavSidebar.tsx` (line 96)
- [ ] Change `translateX(-50%)` to `translateX(-100%)` in `MobileNavDrawer.tsx` (line 163)
- [ ] Update existing unit tests if they assert on the translateX value
- [ ] Run existing nav-toggle tests to verify they pass

## Acceptance Criteria

- [ ] On desktop: clicking "Back to Projects" fully slides to global nav with no text bleeding at left edge
- [ ] On desktop: clicking "Back to [project]" fully slides back to project nav
- [ ] On mobile: nav toggle animation works correctly in drawer
- [ ] Existing nav-toggle tests pass
- [ ] No horizontal overflow on either viewport
