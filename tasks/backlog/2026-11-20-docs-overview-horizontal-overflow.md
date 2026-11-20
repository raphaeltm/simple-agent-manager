# Docs architecture overview page scrolls horizontally

## Problem

`/docs/architecture/overview/` on the marketing site is wider than the viewport:
`document.documentElement.scrollWidth` is 1663 px at 375 px and 1971 px at 1280 px. At 375 px the
overflowing element is a table (`THEAD > TR > TH`); at 1280 px it is reported under Starlight's
right sidebar.

## Context

Found on 2026-11-20 while reviewing Mermaid diagrams for PR #2946. The same numbers appear on a
build of `main` with Mermaid 11, so the upgrade did not cause it.

## Acceptance criteria

- [ ] The page has no document-level horizontal scroll at 375 px and 1280 px
- [ ] Wide tables scroll inside their own container
- [ ] A Playwright check in `apps/www/tests/playwright/` asserts it
