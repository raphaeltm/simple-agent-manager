# Fix Chat Message Duplication and Autoscroll Issues

**Created:** 2026-03-17
**Priority:** High
**Related Report:** `docs/notes/2026-03-17-chat-message-duplication-report.md`

## Problem Statement

Chat messages in the project chat UI experience duplication because 6 independent data sources feed into a single `messages` state array using 3 different update strategies (replace, append, prepend) with deduplication only at render time. This causes:

1. **Visible message duplication** — the same message appears multiple times
2. **Spurious autoscroll** — `messages.length` changes when duplicates are added/removed, triggering scroll-to-bottom when the user has scrolled up
3. **Content jumps during ACP→DO transition** — the 10-second grace period doesn't match the ~2s actual batch delay, causing visual re-renders
4. **Scroll position loss** — full state replacements from polling change the message list, interfering with scroll position tracking

## Research Findings

### Root Causes (from detailed trace analysis)

1. **No state-level deduplication.** The `onMessage` WebSocket callback (line 351) checks `prev.some(m => m.id === msg.id)` but polling (line 561), catch-up (line 371), and load-more (line 685) do full replace/prepend without any dedup checks.

2. **Autoscroll tied to `messages.length`** (line 518). When duplicates inflate the count, `hasNewMessages` evaluates true even though no genuinely new messages arrived. Full replacements from polling can decrease length, making subsequent real new messages invisible to the check.

3. **ACP grace period too long.** The 10s grace (line 425-428) far exceeds the ~2s VM agent batch delay, causing unnecessary time in full-ACP view and a jarring visual switch when grace ends.

4. **Load-more prepend doesn't dedup.** `[...data.messages, ...prev]` (line 685) can duplicate messages that exist in both the older batch and current state.

5. **No scroll preservation during ACP→DO transition.** Unlike load-more (which records scrollHeight and adjusts scrollTop), the ACP→DO switch doesn't preserve scroll position.

### Key Files

| File | Lines | Role |
|------|-------|------|
| `apps/web/src/components/chat/ProjectMessageView.tsx` | 115-250 | `chatMessagesToConversationItems()` — render-time dedup |
| `apps/web/src/components/chat/ProjectMessageView.tsx` | 349-365 | `onMessage` — WebSocket append with ID check |
| `apps/web/src/components/chat/ProjectMessageView.tsx` | 369-373 | `onCatchUp` — full replace |
| `apps/web/src/components/chat/ProjectMessageView.tsx` | 438-454 | `loadSession` — initial load |
| `apps/web/src/components/chat/ProjectMessageView.tsx` | 540-576 | Polling fallback (3s, fingerprint-gated) |
| `apps/web/src/components/chat/ProjectMessageView.tsx` | 668-701 | `loadMore` — prepend |
| `apps/web/src/components/chat/ProjectMessageView.tsx` | 485-534 | Scroll tracking + autoscroll |
| `apps/web/src/components/chat/ProjectMessageView.tsx` | 770-831 | ACP/DO merge + grace period |
| `apps/web/src/hooks/useChatWebSocket.ts` | 121-159 | WebSocket message handler |

## Implementation Checklist

### Phase 1: Create `mergeMessages` utility (state-level deduplication)

- [ ] 1.1 Create `apps/web/src/utils/mergeMessages.ts` with a `mergeMessages` function:
  - Takes `prev: ChatMessageResponse[]`, `incoming: ChatMessageResponse[]`, `strategy: 'replace' | 'append' | 'prepend'`
  - Builds a `Map<string, ChatMessageResponse>` from inputs, deduplicating by ID
  - For `replace`: incoming messages are authoritative, but preserve any `optimistic-*` messages from prev that don't have a content-match in incoming
  - For `append`: add incoming to prev, skip if ID already exists
  - For `prepend`: add incoming before prev, skip if ID already exists
  - Returns a sorted array (by `createdAt`, then by `id` for stability)
- [ ] 1.2 Write unit tests for `mergeMessages`:
  - Basic dedup (same ID in both arrays)
  - Replace preserves optimistic messages
  - Replace reconciles optimistic messages (content match replaces optimistic with server-confirmed)
  - Append skips existing IDs
  - Prepend skips existing IDs
  - Sort stability with identical timestamps
  - Empty arrays and edge cases

### Phase 2: Wire `mergeMessages` into all message sources

- [ ] 2.1 `onMessage` callback (WebSocket append): Replace inline dedup logic with `mergeMessages(prev, [msg], 'append')`
- [ ] 2.2 `onCatchUp` callback: Replace `setMessages(catchUpMessages)` with `mergeMessages(prev, catchUpMessages, 'replace')`
- [ ] 2.3 `loadSession` (initial load): Keep as `setMessages(data.messages)` (clean slate, no merge needed)
- [ ] 2.4 Polling fallback: Replace `setMessages(data.messages)` with `mergeMessages(prev, data.messages, 'replace')`
- [ ] 2.5 `loadMore`: Replace `setMessages(prev => [...data.messages, ...prev])` with `mergeMessages(prev, data.messages, 'prepend')`

### Phase 3: Fix autoscroll to use last message ID instead of length

- [ ] 3.1 Replace `prevMessageCountRef` with `prevLastMessageIdRef` (tracks the last message's ID)
- [ ] 3.2 Change `hasNewMessages` check: instead of `messages.length > prevCount`, check `messages[messages.length - 1]?.id !== prevLastMessageId`
- [ ] 3.3 Verify autoscroll still works correctly for: initial load, new session, new messages at bottom, user scrolled up (should NOT scroll), load-more (should NOT scroll)
- [ ] 3.4 Write behavioral test: render component, simulate user scroll-up, add messages, verify scroll position not changed

### Phase 4: Fix ACP→DO transition

- [ ] 4.1 Reduce grace period from 10s to 3s (closer to actual ~2s VM agent batch delay + 1s buffer)
- [ ] 4.2 Add scroll position preservation during ACP→DO transition:
  - Before transition: record `container.scrollHeight` and `container.scrollTop`
  - After transition renders: adjust `scrollTop` by the delta in `scrollHeight`
  - Use `useLayoutEffect` or `requestAnimationFrame` for timing
- [ ] 4.3 Write test: verify no content jump when switching from ACP to DO view

### Phase 5: Clean up render-time dedup

- [ ] 5.1 The `chatMessagesToConversationItems()` dedup (lines 115-123) can be simplified since state-level dedup now handles it — but keep it as a safety net with a `console.warn` when it catches a duplicate (indicates a bug in the state-level dedup)
- [ ] 5.2 Update the comment to document this is a safety net, not the primary dedup layer

### Phase 6: Tests

- [ ] 6.1 Unit tests for `mergeMessages` (covered in 1.2)
- [ ] 6.2 Behavioral test for autoscroll with deduped messages
- [ ] 6.3 Behavioral test for load-more not triggering autoscroll
- [ ] 6.4 Integration test: simulate rapid polling + WebSocket delivery of same messages, verify no duplicates in rendered output
- [ ] 6.5 Test: optimistic message lifecycle (add optimistic → server confirm via merge → optimistic replaced)

## Acceptance Criteria

- [ ] No duplicate messages visible in the chat UI when multiple delivery paths send the same message
- [ ] Autoscroll to bottom only triggers for genuinely new messages, not dedup/merge artifacts
- [ ] User scroll-up position is preserved when polling/WebSocket updates arrive
- [ ] Load-more does not cause content jumps or trigger autoscroll
- [ ] ACP→DO transition does not cause visible content jumps
- [ ] Grace period reduced from 10s to 3s
- [ ] All existing chat tests pass
- [ ] New tests cover: mergeMessages utility, autoscroll behavior, load-more dedup, optimistic message lifecycle
- [ ] `chatMessagesToConversationItems()` warns (in dev) when catching state-level duplicates
