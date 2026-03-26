# Fix Scroll-to-Bottom Button Overlapping Cancel Button

**Created**: 2026-03-25
**Priority**: Medium
**Classification**: `ui-change`

## Problem

When an agent is actively working and the user scrolls up, the floating "scroll to bottom" button overlaps with the cancel button bar. Both are visible simultaneously but the overlap makes the cancel button difficult to hit — especially on mobile.

## Research Findings

### Key Files
- `apps/web/src/components/chat/ProjectMessageView.tsx` — contains both buttons

### Current Layout
- **Scroll-to-bottom button** (line ~895-910): Absolutely positioned inside the message area container (`div.flex-1.min-h-0.relative`), at `bottom-3 right-4` (12px from bottom, 16px from right). It's a 44px (`w-11 h-11`) circle button with a ChevronDown icon.
- **Cancel bar** (line ~916-928): A separate `div` below the message area, rendered conditionally when `agentSession.isPrompting` is true. Contains "Agent is working..." spinner + Cancel button. Has `py-2` padding, `border-t`, total height ~36-40px.

### State
- `showScrollButton`: Set by Virtuoso's `atBottomStateChange` — true when user scrolls up
- `agentSession.isPrompting`: True when agent is actively generating output

Both can be true simultaneously — the overlap scenario.

### Root Cause
The scroll button is positioned `absolute bottom-3` inside the message area. When the cancel bar appears below the message area, the scroll button sits right at the boundary and visually overlaps with the cancel bar.

## Implementation Checklist

- [x] Add `agentSession.isPrompting` as a condition to shift the scroll button's bottom position
- [x] Change the scroll button className to use a dynamic `bottom` value: `bottom-3` normally, `bottom-14` (56px) when isPrompting is true
- [x] Add `transition-all duration-200` for smooth position change
- [x] Verify touch targets: both buttons must be >= 44x44px with >= 8px gap (w-11 h-11 = 44px, gap = bottom-14 - bottom-3 - h-11 = 56-12-44 = 0 but cancel bar is outside the container)
- [x] Write Playwright visual audit tests for mobile (375px) and desktop (1280px)
- [ ] Test scenarios on staging: only scroll button visible, only cancel visible, both visible

## Acceptance Criteria

- [ ] Scroll-to-bottom button and cancel button are both fully visible and tappable when both are active
- [ ] Touch targets do not overlap (minimum 8px gap)
- [ ] Behavior is correct on both desktop (1280px) and mobile (375px) viewports
- [ ] No layout shift when cancel button appears/disappears — smooth transition
- [ ] Both buttons remain accessible (proper aria-labels, sufficient contrast)
