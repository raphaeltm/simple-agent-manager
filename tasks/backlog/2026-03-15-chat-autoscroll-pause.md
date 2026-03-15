# Chat Autoscroll Pause on Manual Scroll

## Problem

When viewing a project chat, new messages always auto-scroll the view to the bottom. If a user manually scrolls up to read earlier messages, the next arriving message yanks them back to the bottom. This is disruptive — users should be able to read history without being interrupted.

## Research Findings

### Current Implementation
- **File**: `apps/web/src/components/chat/ProjectMessageView.tsx`
- **Autoscroll effect** (lines 483-508): A `useEffect` fires on `[messages.length, loading, sessionId]`. On new messages, session switch, or initial load, it calls `messagesEndRef.current?.scrollIntoView()`.
- **No scroll position detection**: There is zero tracking of whether the user has scrolled away from the bottom. The scroll is unconditional (except when loading older messages via `isLoadingMoreRef`).
- **Scroll container**: `messagesContainerRef` (line 745) — a `div` with `overflow-y-auto`.
- **Sentinel element**: `messagesEndRef` (line 807) — an empty `div` at the bottom of the message list.

### Approach
Standard "stick to bottom" pattern:
1. Track whether the user is at the bottom of the scroll container using a ref (`isStuckToBottomRef`).
2. On scroll events, check if `scrollTop + clientHeight >= scrollHeight - threshold`. If yes, they're "at bottom" → enable autoscroll. If no → disable.
3. Gate the existing autoscroll `scrollIntoView` call on `isStuckToBottomRef.current`.
4. On initial load and session switch, always scroll to bottom and set stuck=true.
5. Use a reasonable threshold (e.g., 50px) to avoid requiring pixel-perfect bottom position.

## Implementation Checklist

- [ ] Add `isStuckToBottomRef = useRef(true)` after existing refs (line ~312)
- [ ] Add `useEffect` with scroll event listener on `messagesContainerRef` that updates `isStuckToBottomRef` based on scroll position
- [ ] Modify autoscroll effect (lines 500-503): only scroll when `isStuckToBottomRef.current` is true OR it's a new session/initial load
- [ ] On session switch (`isNewSession`), reset `isStuckToBottomRef.current = true`
- [ ] Add unit tests for the scroll behavior logic

## Acceptance Criteria

- [ ] When user manually scrolls up in project chat, new messages do NOT auto-scroll the view back to bottom
- [ ] When user scrolls back to the bottom (within threshold), autoscroll resumes for subsequent messages
- [ ] On initial load, chat scrolls to the bottom automatically
- [ ] On session switch, chat scrolls to the bottom automatically
- [ ] "Load earlier messages" continues to preserve scroll position (existing behavior unchanged)

## References

- `apps/web/src/components/chat/ProjectMessageView.tsx` — sole file affected
