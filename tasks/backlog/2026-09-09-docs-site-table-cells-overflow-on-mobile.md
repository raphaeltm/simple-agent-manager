# Docs-site table cells overflow the viewport on mobile

## Problem

On the public docs site, wide markdown tables lay out with **cells extending past the
right edge of a 375px viewport**. The content past the edge is unreachable: the page does
not scroll horizontally and the table has no scroll container.

Measured at 375x667 against the production build (`astro build` + `astro preview`):

| Page                      | Table cells past the viewport | Furthest cell edge |
| ------------------------- | ----------------------------- | ------------------ |
| `guides/instant-sessions` | 24                            | 609px (vw 375)     |
| `guides/idea-execution`   | 20                            | 530px              |
| `guides/agents`           | 30                            | 428px              |

The cause is three-column tables whose cells hold prose. The `<table>` box is constrained
to the content column (`right: 359`), but its cells lay out wider and are not clipped or
scrolled — so the overflow is silent.

## Why the usual checks miss it

This is `.claude/rules/56` one level deeper. Both standard guards return clean:

- `document.documentElement.scrollWidth > window.innerWidth` is **false** — the document
  does not grow, so the page-level check passes.
- The `assertNoClippedOverflow` walk finds nothing — it looks for ancestors with
  `overflow-x: hidden|clip` whose content is wider than their box, and here the ancestors
  are `overflow-x: visible`. Nothing clips; the cells simply render outside the viewport.

The discriminating measurement is per-cell:
`document.querySelectorAll('td,th')` → `getBoundingClientRect().right > window.innerWidth`.

## Context

Found while adding `guides/compute-pools` (PR #2050). That page originally had the single
worst cell on the site (557px), which is why the measurement was taken. Its four
three-column tables were converted to two-column tables and a definition list in the same
PR, so `compute-pools` now measures 0 cells past the viewport. The three pages above are
pre-existing and were deliberately left alone to keep that PR scoped to its subject.

## Acceptance Criteria

- [ ] `instant-sessions`, `idea-execution`, and `agents` measure 0 table cells past the
      viewport at 375px.
- [ ] A sweep of every page under `apps/www/src/content/docs/` confirms no other page
      regresses; record the measurement.
- [ ] Add a per-cell overflow assertion to the www Playwright suite
      (`apps/www/tests/playwright/`) so this cannot silently return. It must be proven
      discriminating: it goes red against the current `instant-sessions` page and green
      after the fix.
- [ ] Consider extending `apps/web/tests/playwright/audit-helpers.ts`'s
      `assertNoClippedOverflow` with the same per-cell check, since the app has the same
      blind spot for any table it renders.
- [ ] Update `.claude/rules/56-clipped-overflow-is-invisible-to-document-checks.md` with
      this third case: an element wider than the viewport that is neither clipped nor
      scrolled is invisible to both existing guards.

## Notes

- Preferred fix is the one used on `compute-pools`: fold three-column prose tables into
  two columns, or into a definition list, rather than adding a horizontal scroll container.
  A scroller is technically reachable but is poor on a phone, and mobile is SAM's primary
  surface.
- Two-column tables with short cells measured fine at 375px; the problem is specifically
  three columns of prose.
