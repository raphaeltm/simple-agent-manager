# Docs Mermaid diagrams should follow the Starlight colour scheme

## Problem

`apps/www/src/scripts/docs-mermaid.ts` always renders with Mermaid's `dark` theme. On the light
Starlight theme the architecture diagram is a grey slab whose labels are about 5-6 px at 375 px
wide and hard to read. The blog renderer (`blog-mermaid.ts`) already picks light or dark theme
variables from the page and re-renders on theme change.

## Context

Seen on 2026-11-20 in the UI review of PR #2946 (Mermaid 12 upgrade). It predates the upgrade.
The dark theme's mindmap and kanban section fills are also near-black in the app chat (low shape
contrast, text still readable).

## Acceptance criteria

- [ ] Docs diagrams use light theme variables on the light Starlight theme and dark on dark
- [ ] Labels in `/docs/architecture/overview/` are readable at 375 px (or the diagram can be
      opened full screen like blog diagrams)
- [ ] Playwright screenshots at 375 px and 1280 px in both themes
