# Fix Read More Modal Mobile Scroll

## Problem

The "Read more" modal for chat session summaries (`TruncatedSummary` component) is impossible to scroll on mobile. The `Dialog` component sets `body.overflow = 'hidden'` when open, but the dialog panel itself has no `max-height` or `overflow-y` constraint. Long summary text causes the dialog to overflow the viewport with no way to scroll.

## Root Cause

In `packages/ui/src/components/Dialog.tsx`, the dialog panel div has no height constraint:
```tsx
<div className={`relative w-full rounded-lg ... ${maxWidthClasses[maxWidth]}`}>
  {children}
</div>
```

When content exceeds viewport height, the panel grows beyond the screen. Since `body.overflow = 'hidden'`, users cannot scroll to see the rest.

## Key Files

- `packages/ui/src/components/Dialog.tsx` — Dialog component (needs max-height + overflow)
- `apps/web/src/components/chat/TruncatedSummary.tsx` — Consumer component
- `apps/web/tests/unit/components/TruncatedSummary.test.tsx` — Existing tests

## Implementation Steps

- [ ] Add `max-h-[calc(100vh-2rem)] overflow-y-auto` to Dialog panel div
- [ ] Add test verifying the dialog panel has scrollable overflow styles
- [ ] Run typecheck, lint, and tests

## Acceptance Criteria

- Dialog content is scrollable when it exceeds viewport height
- Existing Dialog functionality (Escape to close, click overlay to close) still works
- Tests pass
