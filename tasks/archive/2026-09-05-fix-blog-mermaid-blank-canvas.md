# Fix Blank Mermaid Diagrams in Blog Posts

## Problem Statement

The public blog's Mermaid renderer creates the interactive controls and SVG element, but the visible diagram is blank. This affects existing published posts as well as new posts. A blank diagram makes an architecture explanation less useful and can falsely look like a successful visual check unless the rendered SVG viewBox is inspected.

## Evidence

- Local Playwright rendering of both `/blog/sams-journal-the-archive-learned-to-move-slowly/` and the existing `/blog/sams-journal-making-room-for-old-conversations/` produced an SVG inside `.mermaid-canvas`, with no `.mermaid-error`, but no visible diagram.
- For the new post at a 1280px viewport, the rendered SVG had a 638×360px layout box and a non-empty `getBBox()` (2595.8×242), but its final `viewBox` was `1305.8984375 129 0 0`.
- The existing archive journal reproduced the same shape: a 638×360px layout box, a non-empty 2440.3×242 `getBBox()`, and a final `viewBox` of `1228.1640625 129 0 0`.
- `apps/www/src/scripts/blog-mermaid.ts` renders SVG successfully, then `attachPanZoom()` immediately calculates and sets the viewBox. The initial layout measurement or viewBox calculation is collapsing both dimensions to zero.

## Acceptance Criteria

- [x] Blog Mermaid diagrams render visible nodes and edges on desktop and mobile.
- [x] The initial SVG viewBox has non-zero width and height derived from the rendered diagram.
- [x] Pan, zoom, reset, and full-screen controls continue to work.
- [x] Add a browser regression test that checks a Mermaid SVG is visible, not merely present in the DOM.
- [x] Verify at least one existing Mermaid blog post and a new or fixture post at desktop and mobile widths.

## Resolution (2026-09-06)

`renderDiagram()` now places the new `.mermaid-surface` in the document before
`attachPanZoom()` reads its layout box. The old order read a detached 0×0 box
and replaced Mermaid's valid viewBox with an invisible one. Full-screen mode
also raises the blog's root stacking context above the fixed header, so the
Close full screen button remains usable.

`apps/www/tests/playwright/blog-mermaid.spec.ts` verifies an existing archive
post and `sams-journal-the-archive-got-a-clock` at desktop and mobile widths.
It checks the non-zero viewBox and surface, scroll zoom, reset, full screen,
close, and horizontal overflow. The final Playwright run passed all four cases.
