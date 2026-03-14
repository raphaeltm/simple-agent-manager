# Fork Dialog UI Polish

**Created**: 2026-03-14
**Source**: UI/UX review of PR #376 (conversation forking)

## Problem

The ForkDialog and Continue button shipped with functional UI but several polish items remain from the UI/UX review:

1. **Touch target size**: The "Continue" button in `SessionItem` uses `text-xs` with minimal padding, producing a tap area below the 56px minimum for mobile
2. **Mobile drawer close button**: `MobileSessionDrawer` relies on backdrop tap or Escape — no visible close button inside the panel for assistive technology users
3. **Non-forkable session affordance**: Sessions that can't be forked (active, no task) show no indication of why "Continue" is absent — a disabled state with tooltip would improve discoverability
4. **Summary method tooltip**: The `method` field (ai/heuristic/verbatim) shown in the summary metadata is opaque to non-technical users

## Acceptance Criteria

- [ ] Continue button meets 56px minimum touch target (add `py-2 px-1.5` or use shared `Button` with `size="sm"`)
- [ ] MobileSessionDrawer has an accessible close button in the header
- [ ] Non-forkable terminated sessions show a disabled "Continue" with tooltip explaining why
- [ ] Summary method has a `title` attribute explaining what each method means
- [ ] Verify on 375px viewport that ForkDialog is fully usable without background scroll-through

## Context

- `apps/web/src/components/project/ForkDialog.tsx`
- `apps/web/src/pages/ProjectChat.tsx` (SessionItem, MobileSessionDrawer)
- Review report: UI/UX agent review of PR #376
