# Project sidebar nav must scroll on short viewports

**Status**: Active
**Created**: 2026-09-16
**Branch**: `sam/smaller-laptop-section-project-we3ec4`

## Problem

On a smaller laptop the project sidebar section (Chat, Comments, Files, Library,
Ideas, …) does not scroll, so the options at the bottom of the list are
unreachable. There is no scrollbar and no way to bring them into view.

## Research — measured root cause

Probe at 1280x600 (Playwright, `/projects/:id/chat`), measured from the live DOM:

| Element                                 | height | scrollHeight | overflow-y   |
| --------------------------------------- | ------ | ------------ | ------------ |
| `<aside>` (AppShell sidebar)            | 600    | **598**      | `auto`       |
| carousel root (`NavSidebar`)            | 340    | **620**      | **`hidden`** |
| `<nav aria-label="Project navigation">` | 620    | 620          | `visible`    |

`Settings` (last of the 13 `PROJECT_NAV_ITEMS`) measured at `y = 695` — 95px
below the 600px viewport and inside a box that clips at 340px.

Two facts combine into the bug:

1. `NavSidebar.tsx:222` renders the in-project two-panel carousel root as
   `relative overflow-hidden`. Because it is a flex item in the `aside`'s column
   flex context, `overflow: hidden` makes its CSS **automatic minimum size resolve
   to 0** — so it shrinks to whatever space is left instead of pushing the `aside`
   past its height.
2. The `aside` therefore never overflows (`scrollHeight 598 <= clientHeight 598`),
   so its own `overflow-y-auto` never engages. Nothing scrolls anywhere, and the
   clipped items are `overflow: hidden`, i.e. unreachable.

The mobile drawer already solves this correctly
(`MobileNavDrawer.tsx:178-190`: `flex-1 overflow-hidden` wrapper + per-panel
`overflow-y-auto`). The desktop sidebar was never given the same treatment.

`findClippedOverflow` in `audit-helpers.ts` only detects **horizontal** clipping,
which is why this shipped green: there is no vertical counterpart.

## Implementation Checklist

- [ ] `NavSidebar` in-project carousel root: `flex-1 min-h-0` so it owns the
      leftover column space instead of collapsing; keep `overflow-hidden` for the
      horizontal carousel clip.
- [ ] Sliding container gets `h-full`; both `<nav>` panels get `h-full overflow-y-auto`
      so each panel scrolls vertically (mirrors `MobileNavDrawer`).
- [ ] Global (non-project) `<nav>` gets `flex-1 min-h-0 overflow-y-auto` — same
      latent defect, and keeps the footer pinned instead of scrolling away.
- [ ] Regression test asserting **measured coordinates** (rule 17): every project
      nav item's bottom edge is inside its scroll container after scrolling, and
      the container is actually scrollable (`scrollHeight > clientHeight` +
      `scrollTop` moves).
- [ ] Vertical-clipping assertion (the counterpart the audit helper lacks): no
      `overflow-y: hidden` ancestor may clip nav content.
- [ ] Desktop (1280x800, 1280x600) + mobile (375x667) screenshots.

## Acceptance Criteria

- [ ] At 1280x600 every project nav item, including `Settings`, can be scrolled to
      and clicked.
- [ ] The nav scrolls internally; header, Focus toggle, theme switcher and user
      footer stay pinned.
- [ ] The carousel slide animation between project nav and global nav still works.
- [ ] The global (non-project) sidebar scrolls the same way.
- [ ] Focus mode (icon rail) and Zen peek rail still render and scroll.
- [ ] No horizontal overflow at any tested viewport.

## Notes

Verified before the fix: `Settings` bounding box at 1280x600 = `y 695.3, h 36`
inside a 340px-tall `overflow: hidden` box — unreachable, reproducing the report.
