# Fix Horizontal Scrolling on Idea List and Detail Pages

## Problem

The Ideas list page (`IdeasPage.tsx`) and Idea detail page (`IdeaDetailPage.tsx`) still scroll horizontally on mobile devices despite having `overflow-x-hidden` on their root containers. This is a recurring issue that has been addressed multiple times but persists.

## Root Cause Analysis

The `overflow-x-hidden` class on nested page divs only clips content within that div — it does NOT prevent the document body from becoming wider than the viewport. The width constraint must be enforced at every level of the layout chain:

1. **`html`/`body`** — No `overflow-x: hidden` set globally
2. **AppShell `<main>`** — Has `overflow-y-auto` but no `overflow-x` control and no `min-w-0`
3. **Project wrapper `<main>`** — Has `max-w-[80rem]` but no `overflow-x` control
4. **MarkdownRenderer** — Uses `overflow-x-hidden` and `break-words` but:
   - Links (`<a>`) have no `word-break` or overflow protection for long URLs
   - Plain `<pre>` (non-language) only has `m-0`, no overflow control
   - Inline `<code>` has no overflow-wrap
   - `break-words` is weaker than `overflow-wrap: anywhere` for unbroken strings
5. **Page containers** — Use `overflow-x-hidden` but lack explicit `w-full max-w-full` width constraints

## Research Findings

- **Key files**: `IdeasPage.tsx`, `IdeaDetailPage.tsx`, `MarkdownRenderer.tsx`, `AppShell.tsx`, `Project.tsx`, `index.css`
- **Layout chain**: AppShell → Project → IdeasPage/IdeaDetailPage → MarkdownRenderer
- **Existing tests**: `ideas-ui-audit.spec.ts`, `idea-detail-audit.spec.ts` — have `assertNoOverflow()` but may not catch all edge cases because Playwright's `scrollWidth > innerWidth` check can be masked by parent `overflow-x-hidden`
- **Tailwind class `break-words`** maps to `overflow-wrap: break-word` which only breaks at soft wrap opportunities. `overflow-wrap: anywhere` is stronger — it allows breaks anywhere.

## Implementation Checklist

- [ ] 1. Add `overflow-x: hidden` to `html, body` in `index.css` as the ultimate safety net
- [ ] 2. Add `min-w-0 overflow-x-hidden` to AppShell `<main>` elements (both mobile and desktop layouts)
- [ ] 3. Add `overflow-hidden` and `min-w-0` to Project wrapper containers
- [ ] 4. Fix MarkdownRenderer:
  - [ ] 4a. Change root div from `break-words` to `overflow-wrap: anywhere` (via style or Tailwind `break-all` where needed)
  - [ ] 4b. Add `overflow-wrap: anywhere; word-break: break-all` to `<a>` links
  - [ ] 4c. Add `overflow-x: auto; max-width: 100%` to plain `<pre>` elements
  - [ ] 4d. Add `overflow-wrap: anywhere` to inline `<code>` elements
- [ ] 5. Add `w-full max-w-full` to IdeasPage and IdeaDetailPage root containers
- [ ] 6. Update Playwright tests with more aggressive overflow test data:
  - [ ] 6a. Add 500+ char unbroken strings (no spaces, no hyphens)
  - [ ] 6b. Add very long URLs as both plain text and markdown links
  - [ ] 6c. Add long inline code strings
  - [ ] 6d. Add wide tables with many columns
  - [ ] 6e. Add deeply nested lists
  - [ ] 6f. Improve `assertNoOverflow` to also check `body.scrollWidth`
- [ ] 7. Run Playwright tests at 375px and 1280px and verify zero horizontal overflow
- [ ] 8. Verify existing unit tests still pass

## Acceptance Criteria

- [ ] No horizontal scrolling on ideas list page at 375px viewport with any content length
- [ ] No horizontal scrolling on idea detail page at 375px viewport with any content length
- [ ] No horizontal scrolling at 1280px desktop viewport
- [ ] Long unbroken strings (500+ chars) wrap properly
- [ ] Long URLs in markdown wrap properly (both as links and plain text)
- [ ] Code blocks scroll horizontally within their container, not the page
- [ ] Tables scroll horizontally within their container, not the page
- [ ] All existing Playwright and unit tests pass
- [ ] New Playwright tests with aggressive edge case data all pass with no overflow
