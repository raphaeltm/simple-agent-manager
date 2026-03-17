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

- [x] 1.1 Create `apps/web/src/lib/merge-messages.ts` with a `mergeMessages` function (path adjusted from planned `utils/` to `lib/` to match project conventions)
- [x] 1.2 Write unit tests for `mergeMessages` — 26 tests covering all strategies, optimistic reconciliation, sort stability, edge cases

### Phase 2: Wire `mergeMessages` into all message sources

- [x] 2.1 `onMessage` callback: `mergeMessages(prev, [msg], 'append')`
- [x] 2.2 `onCatchUp` callback: `mergeMessages(prev, catchUpMessages, 'replace')`
- [x] 2.3 `loadSession` (initial load): Kept as `setMessages(data.messages)` (clean slate)
- [x] 2.4 Polling fallback: `mergeMessages(prev, data.messages, 'replace')`
- [x] 2.5 `loadMore`: `mergeMessages(prev, data.messages, 'prepend')`

### Phase 3: Fix autoscroll to use last message ID instead of length

- [x] 3.1 Replaced `prevMessageCountRef` with `prevLastMessageIdRef`
- [x] 3.2 Changed `hasNewMessages` to compare last message IDs
- [x] 3.3 Verified autoscroll behavior: initial load, new session, new messages, user scrolled up, load-more
- [ ] 3.4 Behavioral autoscroll test — deferred; existing `project-message-view.test.tsx` already covers scroll-up suppression; jsdom layout limitations make dedup-specific scroll test impractical

### Phase 4: Fix ACP→DO transition

- [x] 4.1 Reduced grace period to 3s (configurable via VITE_ACP_GRACE_MS env var)
- [x] 4.2 Added scroll position preservation via `prevAcpGraceRef` + `requestAnimationFrame`
- [ ] 4.3 ACP→DO transition test — deferred; jsdom has no layout engine so scrollHeight-based assertions are not possible

### Phase 5: Clean up render-time dedup

- [x] 5.1 Added `console.warn` safety net in dev mode
- [x] 5.2 Updated comment to document safety-net role

### Phase 6: Tests

- [x] 6.1 Unit tests for `mergeMessages` — 26 tests
- [ ] 6.2 Dedup-specific autoscroll behavioral test — deferred (jsdom limitation)
- [ ] 6.3 Load-more autoscroll behavioral test — deferred (jsdom limitation)
- [ ] 6.4 Integration dedup test — deferred; unit tests cover mergeMessages logic; component-level integration requires significant mock infrastructure
- [x] 6.5 Optimistic message lifecycle tests — covered via append reconciliation + replace preservation tests

## Acceptance Criteria

- [x] No duplicate messages visible in the chat UI when multiple delivery paths send the same message
- [x] Autoscroll to bottom only triggers for genuinely new messages, not dedup/merge artifacts
- [x] User scroll-up position is preserved when polling/WebSocket updates arrive
- [x] Load-more does not cause content jumps or trigger autoscroll
- [x] ACP→DO transition does not cause visible content jumps
- [x] Grace period reduced from 10s to 3s (configurable via VITE_ACP_GRACE_MS)
- [x] All existing chat tests pass (1248 tests)
- [x] New tests cover: mergeMessages utility (26 tests), source-contract for all wiring paths
- [x] `chatMessagesToConversationItems()` warns (in dev) when catching state-level duplicates
