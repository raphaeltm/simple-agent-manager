# Fix Chat Message Loading Limits and Load-More Scroll Behavior

## Problem

1. **Insufficient message loading**: Chat sessions only load 100 messages by default (max 500). Agent sessions produce many messages, causing users to see only half of a response. Need ~10x increase.

2. **Scroll jumps on "Load more"**: Clicking "Load earlier messages" prepends messages, but the auto-scroll effect detects `messages.length > prevMessageCountRef.current` and scrolls to the bottom — the opposite of the user's intent.

## Research Findings

### Current Limits
| Location | Default | Max Cap |
|----------|---------|---------|
| `apps/api/src/routes/chat.ts:120` | 100 | 500 |
| `apps/api/src/durable-objects/project-data.ts:434` | 100 | N/A |

### Scroll Bug Root Cause
- `ProjectMessageView.tsx:428-443`: Auto-scroll effect checks `messages.length > prevMessageCountRef.current`
- When `loadMore()` completes, React 18 batches `setMessages()` and `setLoadingMore(false)` together
- By the time the effect runs, `loadingMore` is `false` and `hasNewMessages` is `true` → scrolls to bottom
- No mechanism distinguishes "prepended older messages" from "appended new messages"

### Key Files
- `apps/web/src/components/chat/ProjectMessageView.tsx` — message view, scroll logic, load more
- `apps/api/src/routes/chat.ts` — API route with limit parsing
- `apps/api/src/durable-objects/project-data.ts` — DO query with default limit

## Implementation Checklist

- [ ] Increase API route default limit from 100 to 1000 (`chat.ts:120`)
- [ ] Increase API route max cap from 500 to 5000 (`chat.ts:120`)
- [ ] Increase DO default limit from 100 to 1000 (`project-data.ts:434`)
- [ ] Add a `loadMoreRef` flag to distinguish prepend vs append in the scroll effect
- [ ] Preserve scroll position after prepending messages (save scrollTop + scrollHeight before, restore after)
- [ ] Verify auto-scroll still works for new messages during active sessions
- [ ] Run typecheck, lint, and tests

## Acceptance Criteria

- [ ] Initial load fetches up to 1000 messages (10x previous)
- [ ] Max cap allows up to 5000 messages per request
- [ ] Clicking "Load earlier messages" does NOT scroll the view
- [ ] Scroll position is preserved when older messages are prepended
- [ ] New messages during active sessions still auto-scroll to bottom
- [ ] All quality checks pass (typecheck, lint, test, build)
