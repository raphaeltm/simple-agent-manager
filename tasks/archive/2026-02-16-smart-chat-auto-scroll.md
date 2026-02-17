# Smart Chat Auto-Scroll

**Created**: 2026-02-16
**Status**: active

## Problem

When scrolled to the bottom of a chat session, new messages and streaming content should auto-scroll to keep the latest content visible. However, when the user scrolls up to read earlier messages or click on things, the chat should NOT yank them back to the bottom.

## Current Behavior

- `AgentPanel.tsx` has a `useEffect` that scrolls to bottom whenever `messages.items.length` changes
- This fires on every new message, regardless of user's scroll position
- Streaming chunk updates (which modify existing messages without changing length) do NOT trigger scroll at all

## Desired Behavior

1. **At bottom**: Auto-scroll follows new content (new messages AND streaming chunks)
2. **Scrolled up**: No auto-scroll — user can read/click freely
3. **Scroll back to bottom**: Re-engages auto-scroll (stick-to-bottom)

## Implementation

- [x] Create `useAutoScroll` hook with stick-to-bottom logic
- [x] Integrate into `AgentPanel` replacing current `useEffect`
- [x] Add comprehensive unit tests for the hook
- [x] Add integration tests for AgentPanel scroll behavior
- [x] Ensure all tests pass

## Technical Approach

- Custom `useAutoScroll` hook tracking "is at bottom" state via scroll events
- Use a threshold (e.g., 50px) to determine "at bottom" — accounts for fractional pixels and minor drift
- On content mutations (ResizeObserver or dependency changes), scroll to bottom only if "stuck"
- Expose `isAtBottom` for potential "scroll to bottom" button in the future
