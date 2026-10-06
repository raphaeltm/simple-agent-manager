# Resource Panel UI Improvements

## Problem

The session resource history drawer (`SessionResourceHistoryDrawer.tsx`) has three issues:

1. **Mobile scroll bug**: The `<dialog>` element has no explicit height, so the UA stylesheet's `fit-content` sizing makes it grow past the viewport. Combined with `overflow-hidden`, the inner scroller never overflows and the panel can't be scrolled on mobile.

2. **Content hierarchy**: The chart (the most useful element) is buried at the bottom, below a chunk list users must scroll past. Chunks are not useful to end users (only agents). High-level metrics and tool-call-to-resource correlation should be prominent.

3. **Dead Tailwind classes**: Several class names (`bg-bg-surface`, `bg-bg-subtle`, `bg-bg-hover`, `border-accent-primary`, `bg-accent-primary/10`) are not registered in the design system and silently produce no styling.

## Research Findings

- **Root cause of scroll bug**: dialog with no explicit height → UA stylesheet `fit-content` → dialog grows past viewport → `overflow-hidden` clips → inner scroller never overflows
- **Fix pattern**: Comments drawer (`SessionCommentsDrawer.tsx`) uses `glass-panel-container glass-composited glass-modal` with `h-[100dvh] w-[100dvw] max-h-[100dvh] max-w-[100dvw]` — this is the proven pattern to match
- **Registered Tailwind names**: `bg-surface`, `bg-inset`, `bg-surface-hover`, `bg-accent`, `border-accent` (not the `bg-bg-*` variants)
- **Prototype exploration**: Three variant prototypes (A, B, C) were built to explore layouts. Decision: Variant A's shell (consistent with Comments/Timeline/Events drawers) + Variant C's content hierarchy (stats → chart → chunks deprioritized)

## Implementation Checklist

- [x] Fix dialog shell to match Comments drawer pattern (glass classes, viewport pinning)
- [x] Reorder content: stat cards → OOM banner → chart (auto-loaded) → correlation note → chunks (collapsed disclosure)
- [x] Auto-load newest chunk detail via useEffect
- [x] Add ChunksDisclosure component (collapsed by default with chevron toggle)
- [x] Fix dead Tailwind class names
- [x] Remove tool window truncation (.slice(0, 6))
- [x] Fix close button hit target (remove min-h-14 min-w-14)
- [x] Remove prototype files and routes before merge

## Acceptance Criteria

- [x] Resource panel scrolls on mobile (375px viewport)
- [x] Chart appears immediately on panel open (no manual chunk selection required)
- [x] Stats (CPU peak, RAM peak, I/O, Samples) are visible at top
- [x] Chunks are behind a collapsed disclosure toggle
- [x] All tool windows shown (no truncation)
- [x] Dialog shell matches Comments drawer geometry
- [x] No prototype files or routes remain in the codebase
- [x] Typecheck and lint pass

## References

- Production file: `apps/web/src/components/chat/SessionResourceHistoryDrawer.tsx`
- Pattern reference: `apps/web/src/components/chat/SessionCommentsDrawer.tsx`
- Branch: `sam/new-ui-resources-being-qd7mnj`
