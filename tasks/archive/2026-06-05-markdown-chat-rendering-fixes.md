# Markdown Chat Rendering Fixes (graduate prototype → real project chat)

**Date:** 2026-06-05
**Status:** complete

## Problem Statement

The real project chat (`apps/web/src/pages/project-chat/` → `ProjectMessageView` →
`AcpConversationItemView` → acp-client `MessageBubble`) renders complex markdown
poorly. Three CSS defects and one rendering bug were investigated and fixed in the
throwaway prototype at `apps/web/src/pages/markdown-chat-prototype/`, verified via
Playwright at mobile (375) and desktop (1280), and approved. This task graduates the
approved changes into production and deletes the prototype.

### Defects

1. **List markers vanish.** Tailwind v4 preflight resets `ol, ul { list-style: none }`.
   `apps/web/src/styles/acp-chat.css` styles `.prose ul/ol` (margin + padding) but never
   re-declares `list-style`, so numbers/bullets disappear in chat.
2. **Agent bubbles hard to distinguish** on the dark canvas. `.glass-msg-assistant`
   (`apps/web/src/index.css`) is a flat dark fill with no accent. Approved treatment: a
   subtle green border + outer green glow + inner bottom-pooling glow + a green gradient
   hairline along the bottom edge.
3. **Tables are unreadable.** `acp-chat.css` has NO `.prose table/th/td` rules, so cells
   have no padding/borders and columns collapse to slivers. Approved treatment: green grid
   lines, header tint, zebra striping, per-column `min-width` so narrow columns don't
   collapse, and horizontal scroll for wide tables (the `.prose` container already has
   `overflow-x-auto`).
4. **Language-less fenced code blocks render inline, losing line breaks.**
   `packages/acp-client/src/components/MessageBubble.tsx` `makeCodeComponent` computes
   `isInline = !match && !className` (line ~126). A ```` ``` ```` block with no language
   has no `language-*` class, so it is misclassified as inline `<code>`, collapsing
   newlines. CSS cannot fix this — it is a classification bug.

## Research Findings

- `acp-chat.css` is imported as a side-effect only in `apps/web/src/pages/workspace/index.tsx`,
  which is **statically** imported in `App.tsx`. Vite therefore bundles its `.prose` rules
  globally, so they already apply to the project chat — which is exactly why these bugs
  manifest in the real chat. Adding list/table rules to `acp-chat.css` is the correct home.
- Prototype CSS (`prototype.css`) is the source of truth for the approved styles, scoped
  under `.md-proto`. Graduation must DROP the `.md-proto` prefix.
- Base `.glass-msg-assistant` lives in `apps/web/src/index.css` inside `@layer utilities`
  (lines ~347-353). The glow must layer on top and needs `position: relative` for the
  `::after` hairline.
- Both user and agent bubbles render `<div className="prose ...">`, so list + table rules
  apply to both automatically. The green glow is approved for the agent bubble only (user
  bubbles already have a distinct green gradient).
- `MessageBubble.tsx` defines two code components: `makeCodeComponent('bg-blue-500 ...')`
  for user and `makeCodeComponent('bg-gray-100 ...')` for agent. `HighlightedCode` renders
  a `<pre>` with line numbers. Inline code never contains newlines, so a multi-line
  language-less block is reliably a block.

## Implementation Checklist

- [x] **acp-chat.css — list markers.** Add (unscoped) `.prose ol { list-style-type: decimal }`,
      `.prose ul { list-style-type: disc }`, nested `ul ul → circle`, `ul ul ul → square`,
      `ol ol → lower-alpha`, `list-style-position: outside`, `li { padding-left: 0.125rem }`,
      and `ul.contains-task-list { list-style-type: none; padding-left: 0.25rem }`.
- [x] **acp-chat.css — tables.** Add `.prose table` (border-collapse, width:auto,
      min-width:100%, margin, font-size, line-height), `.prose th/td` (padding, green border,
      text-align, vertical-align, min-width:6rem, max-width:18rem), `.prose thead th` (tint,
      bottom border, font-weight:600, white-space:nowrap), `.prose tbody tr:nth-child(even) td`
      (zebra tint).
- [x] **index.css — green glow.** Update `.glass-msg-assistant` with `position: relative`,
      layered green background gradient, green border, box-shadow (rim + depth + outer glow +
      inner bottom pool), and a `.glass-msg-assistant::after` bottom gradient hairline.
- [x] **MessageBubble.tsx — code fix.** Replace `isInline = !match && !className` with
      `isBlock = !!match || code.includes('\n')`. Render: not block → inline pill `<code>`;
      `match` → `HighlightedCode`; language-less block → plain `<pre>` (dark bg, whitespace-pre,
      overflow-x-auto, no line numbers).
- [x] **Delete prototype.** N/A in this worktree — prototype files (`markdown-chat-prototype/`,
      App.tsx import+route, `audit-*.mjs`) only ever existed as uncommitted local files in the
      MAIN worktree, never committed to origin/main, so the feature branch is already clean.
      Verified: no prototype dir, no App.tsx refs, no audit scripts present.
- [x] **Local Playwright visual audit.** `apps/web/tests/playwright/markdown-chat-rendering-audit.spec.ts`
      renders the real project chat with lists, tables, typed + language-less code blocks at 375
      and 1280; asserts computed list-style markers, table cell borders, ≥2 `<pre>`, language-less
      newline preservation, and `scrollWidth <= innerWidth`. All pass; screenshots captured.

## Acceptance Criteria

- [ ] Ordered lists show numbers, unordered show disc/circle/square; task lists show no bullet.
- [ ] Agent bubbles have a visible green edge + glow distinct from the canvas; user bubbles unchanged.
- [ ] Tables render with grid lines, header tint, zebra rows; narrow columns don't collapse;
      wide tables scroll horizontally within the bubble (no page overflow at 375 or 1280).
- [ ] A language-less fenced code block preserves line breaks (renders as a block, not inline).
- [ ] No `/prototype/markdown-chat` route or prototype files remain.
- [ ] Behavioral test for `MessageBubble` proves a multi-line language-less block renders as a
      `<pre>` block (not inline `<code>`).

## References

- `.claude/rules/37-prototype-development.md` (prototypes are throwaway; delete on graduation)
- `.claude/rules/29-local-first-debugging.md` (prototype artifacts are not deliverables)
- `.claude/rules/17-ui-visual-testing.md` (mandatory Playwright audit for apps/web changes)
- Prototype source: `apps/web/src/pages/markdown-chat-prototype/prototype.css`
