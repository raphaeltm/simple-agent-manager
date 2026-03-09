# Fix Read More Modal Mobile UI

## Problem

The "Read more" modal for task summaries is unusable on mobile:
- Text is too large for mobile viewports
- No scrolling when content exceeds viewport height
- Content goes off the edges of the screen
- Overall layout is broken/unusable on small screens

Root cause: The `Dialog` component (`packages/ui/src/components/Dialog.tsx`) has no max-height constraint or overflow scrolling, and uses fixed `p-6` padding regardless of viewport size. The `TruncatedSummary` modal content uses default text sizes that are too large for mobile.

## Research Findings

**Key files:**
- `packages/ui/src/components/Dialog.tsx` — shared modal component, no height constraint or scroll
- `apps/web/src/components/chat/TruncatedSummary.tsx` — "Read more" trigger + modal content
- `apps/web/tests/unit/components/TruncatedSummary.test.tsx` — existing tests (no mobile viewport tests)

**Issues identified:**
1. Dialog has no `max-h-*` or `overflow-y-auto` — long content pushes modal off-screen
2. Dialog uses `p-6` on all viewports — too much padding on mobile
3. Modal text uses `text-lg` for title and base size for body — too large on mobile
4. No mobile-specific tests exist for any UI components

**Class of bug:** Untested responsive/mobile layout — components built and tested only at desktop sizes.

## Implementation Checklist

- [ ] Fix `Dialog.tsx`: add `max-h-[90vh]`, `overflow-y-auto`, responsive padding (`p-4 sm:p-6`)
- [ ] Fix `TruncatedSummary.tsx`: use responsive text sizes in modal (`text-sm sm:text-base`)
- [ ] Add mobile viewport tests for `TruncatedSummary` modal
- [ ] Add mobile viewport tests for `Dialog` component
- [ ] Add mobile viewport testing requirement to `.claude/rules/02-quality-gates.md`
- [ ] Create post-mortem in `docs/notes/`
- [ ] Archive task file

## Acceptance Criteria

- [ ] Read More modal is usable on 375px-wide mobile viewport
- [ ] Long content scrolls within the modal, not off-screen
- [ ] Text is appropriately sized for mobile
- [ ] Modal fits within viewport with proper padding
- [ ] Tests verify modal renders correctly at mobile viewport sizes
- [ ] Process fix ensures future UI changes are tested at mobile widths

## References

- `.claude/rules/02-quality-gates.md` — quality gates (process fix target)
- `.github/pull_request_template.md` — PR template (has mobile verification checkbox)
