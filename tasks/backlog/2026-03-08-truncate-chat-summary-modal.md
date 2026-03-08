# Truncate Chat Summary Messages with Modal Expand

## Problem

Summary messages in the project chat (`taskEmbed.outputSummary`) can be arbitrarily long. On mobile, they take up excessive screen real estate in the header bar. Users need a way to see a truncated preview and expand to read the full summary.

## Research Findings

- **Summary location**: `ProjectMessageView.tsx:710-719` renders `taskEmbed.outputSummary` as an inline status bar above the messages area
- **Also rendered in**: `TaskDetail.tsx:296-300` — full summary in task detail page (no truncation needed there)
- **Dialog component**: `packages/ui/src/components/Dialog.tsx` — existing modal with backdrop, escape-to-close, configurable max-width
- **Styling**: Uses Tailwind + SAM design tokens (`sam-type-caption`, `text-success`, `bg-success-tint`)

## Implementation Checklist

- [ ] Create a `TruncatedSummary` component in `apps/web/src/components/chat/`
  - Truncate text with CSS `line-clamp-2` (2 lines max)
  - Show "Read more" button/link when text overflows
  - Use `useState` for modal open/close
  - Render full summary in `Dialog` from `@simple-agent-manager/ui`
- [ ] Replace inline summary rendering in `ProjectMessageView.tsx` with `TruncatedSummary`
- [ ] Add behavioral tests: render, truncation detection, click opens modal, modal shows full text
- [ ] Run typecheck, lint, and test

## Acceptance Criteria

- Summary text is truncated to 2 lines in the chat header bar
- A "Read more" indicator is visible when text is truncated
- Clicking opens a modal with the full summary text
- Modal closes on backdrop click or Escape
- Short summaries that fit in 2 lines show normally without "Read more"
- Existing TaskDetail page rendering is unchanged
