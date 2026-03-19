# Fix Scroll-to-Bottom Button Overlapping Cancel Button

**Created**: 2026-03-19
**Priority**: Medium
**Classification**: `ui-change`

## Problem

When an agent is actively working, the floating "scroll to bottom" button overlaps with the cancel button (used to stop the agent). The cancel button is still partially visible/touchable but the overlap makes it difficult to use — especially on mobile where touch targets are critical.

## Context

- Scroll-to-bottom button was implemented and works correctly for its primary purpose
- The cancel button appears when `isPrompting` is true (agent actively generating)
- The scroll-to-bottom button appears when `isStuckToBottomRef.current === false` (user scrolled up)
- Both can be visible simultaneously: agent is working AND user scrolled up to read earlier output
- The overlap is most problematic on mobile where the buttons are closer together and touch targets matter more

## Proposed Solutions

### Option A: Shift scroll button up when cancel is visible

When the cancel button is rendered, offset the scroll-to-bottom button upward by the cancel button's height + spacing. Simple CSS/positioning change.

### Option B: Combine into a stacked button group

When both are needed, render them as a vertical stack (scroll-to-bottom above, cancel below) with proper spacing. Single visual unit, no overlap.

### Option C: Move scroll button to a different position

Place the scroll-to-bottom button on the left side or as a banner/bar rather than a floating button, avoiding the conflict entirely.

**Recommendation**: Option A is simplest and preserves existing behavior. Just needs awareness of cancel button visibility state.

## Acceptance Criteria

- [ ] Scroll-to-bottom button and cancel button are both fully visible and tappable when both are active
- [ ] Touch targets do not overlap (minimum 8px gap)
- [ ] Behavior is correct on both desktop and mobile viewports
- [ ] No layout shift when cancel button appears/disappears
- [ ] Both buttons remain accessible (proper aria-labels, sufficient contrast)
