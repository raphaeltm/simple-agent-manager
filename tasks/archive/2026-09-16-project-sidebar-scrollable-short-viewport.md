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

- [x] `NavSidebar` in-project carousel root: `flex-1 min-h-0` so it owns the
      leftover column space instead of collapsing; keep `overflow-hidden` for the
      horizontal carousel clip.
- [x] Sliding container gets `h-full`; both `<nav>` panels get `h-full overflow-y-auto`
      so each panel scrolls vertically (mirrors `MobileNavDrawer`).
- [x] Global (non-project) `<nav>` gets `flex-1 min-h-0 overflow-y-auto` — same
      latent defect, and keeps the footer pinned instead of scrolling away.
- [x] Regression test asserting **measured coordinates** (rule 17): 11 tests in
      `apps/web/tests/playwright/project-sidebar-scroll-audit.spec.ts`. Each asserts
      its own precondition (`scrollHeight > clientHeight`) so it cannot pass
      vacuously, and the reachability tests end by CLICKING the item and asserting
      navigation.
- [x] Vertical-clipping assertion — `assertNoVerticalClipping` / `findVerticalClipping`
      added to `apps/web/tests/playwright/audit-helpers.ts`, beside their horizontal
      twin `findClippedOverflow`. Ancestor-scoped, not a repo-wide sweep, per the
      progressive quality-tool rollout policy.
- [x] Desktop (1280x800, 1280x600, 1280x500 Zen) + tablet (768x1024) + mobile
      (375x667) screenshots, before/after, reviewed by eye.
- [x] Remove `mt-auto` from `AppShell.tsx` — made dead by the nav's `flex-1`
      (architecture reviewer measured `marginTop: 0px` at 7 sidebar heights).
- [x] Document the `aside`'s `overflow-y-auto` as a live backstop (engages below
      ~258px of sidebar height), not redundant code.

## Acceptance Criteria

- [x] At 1280x600 every project nav item, including `Settings`, can be scrolled to
      and clicked — asserted locally AND on live staging, ending in a real click
      plus `waitForURL` to `/projects/:id/settings`.
- [x] The nav scrolls internally; header, Focus toggle, theme switcher and user
      footer stay pinned — coordinate assertion that the chrome does not move while
      the nav scrolls to its end.
- [x] The carousel slide animation still works — entered through the real toggle
      button; the global panel's measured x confirms it landed.
- [x] The global (non-project) sidebar scrolls the same way, with 30 projects.
- [x] Focus mode (icon rail) AND Zen peek rail both covered. Zen was initially
      dismissed by reasoning ("the panel is viewport-height, so it cannot clip") and
      that reasoning was WRONG — measuring showed 604px of nav in a 598px panel.
      Now tested at 1280x500, entered by hovering the real Zen seam.
- [x] No horizontal overflow at any tested viewport — via the shared
      `assertNoOverflow`, which also walks for clipped (sheared) content.

## Notes

Verified before the fix: `Settings` bounding box at 1280x600 = `y 695.3, h 36`
inside a 340px-tall `overflow: hidden` box — unreachable, reproducing the report.

**Blast radius was wider than reported.** The 13-item nav needs 604px but the
sidebar chrome leaves only 540px at the standard 1280x800 height, so the last item
was already unreachable there too — just far worse on a short laptop. Focus mode
and the Zen peek rail were affected as well.

**Discrimination proof** (rule 62), re-run after every change against a
separately-built pre-fix bundle served on its own port: **8 red, 3 green**. The 3
that stay green pre-fix are deliberate controls (chrome-pinned, horizontal-overflow,
mobile-drawer) — without them a globally-red suite would look like proof.

**Two of my own tests were wrong and were fixed, not re-run until green:**

1. The staging spec's first run failed all 5 tests — `a[href^="/projects/"]` matched
   only sidebar nav links (project cards are not anchors), and the first-run cloud
   wizard is an `inset-0 z-50` overlay that swallows clicks, which the shared 2s
   dismiss probe missed because the dialog mounts later over a real network.
2. A later flake traced to asserting on `heading "Projects"`, which is an `sr-only`
   h1 with a 1x1 box — it would be satisfied by a page whose entire project grid
   failed to render. Replaced with the New Project control plus a real project name.

**Why this shipped green in the first place:** `findClippedOverflow` detects only
HORIZONTAL clipping. There was no vertical counterpart, so a nav sheared off at the
bottom was invisible to every guard, and the existing sidebar specs assert
`toBeVisible()`, which returns true for an element parked 95px below the fold.
Every viewport in `playwright.config.ts` is either mobile (drawer, unaffected) or
1024px+ tall, so nothing exercised a short desktop window.
