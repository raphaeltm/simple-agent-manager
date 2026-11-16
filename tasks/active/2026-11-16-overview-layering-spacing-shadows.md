# Project Overview: clipped shadows, layering and spacing

SAM task 01M7JPQYXA9P0SGVE5ZMTHPGZ5 (replaces 01M7J8G33ZT1AJ4TQJZ7G0F571). Owner asked to skip
staging and ship straight to production once CI, the reviewers and the Playwright audit pass.

## Problem

Raphaël, 2026-11-16 13:24Z, with a screenshot of the Project Overview (`/projects/:id/overview`):
"some of the layering/spacing is a bit wacky. Shadows being clipped. Elements not overlapping
properly." The screenshot is not available; the defects below were found by capturing the page
locally (375x667 and 1280x800, dark SAM Glass, busy-project mocks, top and scrolled) on the F2
layout (PR #2793) that is about to be in production.

## Findings (each with its cause)

1. **Pane shadows cut off in hard rectangles.** Phone: `overview-scroll` is `overflow-y-auto`
   and exactly as wide as the panes, so every pane's shadow stops at the pane's own left/right
   edge and at the scroller's bottom. Desktop: `overview-main` and `overview-rail` are each
   `overflow-y-auto` with the same problem. Rule 80 #3: nothing between a pane and the void may
   clip. The existing audit's full-page capture forced `overflow: visible` on every ancestor, so
   it could never show this.
2. **Panes sliced in mid-air when scrolled.** The same scrollers end a gap short of their
   neighbours, so a pane scrolled away is cut along an invisible line 10px under the phone app
   bar, 16px under the top of the screen on desktop, and 14px above the task box (worst with the
   task box's options panel open: the Needs you pane is severed, leaving a stub of its border).
3. **Stacked inbox row shows its back cards through the front card.** `InboxRow` (shared with
   the Inbox pages) draws two translucent back cards that sit partly behind the translucent
   front card, so their outlines show through it.
4. **Recently mixes two row shapes.** Ideas used the Ideas page's full-width `IdeaRow` (px-4,
   dividers, bold, chevron, 32px tinted icon) next to the Overview's own rows (px-2, 18px
   icon, no dividers): different icon column and text edge in one pane.

Looked at and left alone: gaps between panes (14px everywhere, consistent), profile picker and
options popovers (correct stacking), Budgets / This week / Automations content.

## Checklist

- [x] AppShell exposes its frame and gap as `--sam-shell-frame` / `--sam-shell-gap`
- [x] OverviewLayout scrollers bleed into their surroundings and pad back (phone + desktop)
- [x] InboxRow back cards clipped to the strip below the front card
- [x] Recently idea rows use the Overview row shape; `IdeaRow`'s now-unused `compact` removed
- [x] Playwright: pane shadows unclipped (measured, top and scrolled to end, both viewports)
- [x] Playwright: Recently idea and PR rows share icon column and text edge
- [x] Both checks proven red on the pre-fix code
- [ ] Inbox page and Ideas page re-checked (shared InboxRow / IdeaStateIcon)
- [ ] Light theme checked
- [ ] Before/after screenshots posted on the PR
- [ ] ui-ux-specialist and task-completion-validator reviews
- [ ] CI green, merged, production deploy watched

## Acceptance criteria

- No pane shadow is cut by a scroller at 375x667 or 1280x800, at the top or end of scroll.
- A pane scrolled out of view disappears at the app bar / task box / screen edge.
- The stacked row shows no outlines through its front card.
- Recently's rows share one icon column and text edge.
- No behaviour change; F2's and the existing Overview audits stay green.
