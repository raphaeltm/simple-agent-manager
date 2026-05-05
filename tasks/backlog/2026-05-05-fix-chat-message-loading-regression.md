# Fix Chat Message Loading Regression

## Problem

PR #874 ("Fix oversized chat session message loads", May 1st) introduced two compounding regressions:

1. **Message limit slashed from 1000 to 200**: `getSessionMessageLimit()` in `apps/api/src/routes/chat.ts` was changed to use `DEFAULT_SAM_HISTORY_LOAD_LIMIT` (200) — a constant designed for SAM's own conversation persistence. The previous default was 1000 (capped at 5000). For streaming-token chat messages where each token batch is a separate DB row, 200 rows covers only a small portion of a conversation.

2. **Polling fallback (every 3s) discards earlier-loaded messages**: The poll in `useSessionLifecycle.ts` calls `getChatSession()` with no limit (gets 200), then `mergeMessages(prev, data.messages, 'replace')`. The `replace` strategy treats incoming as authoritative and discards all previously-loaded earlier messages. So even after clicking "Load earlier messages", the next 3-second poll cycle resets back to just the latest 200. Same issue with WebSocket `onCatchUp`.

## Research Findings

### Key Files
- `apps/api/src/routes/chat.ts` — `getSessionMessageLimit()` function (lines 31-39)
- `apps/web/src/components/project-message-view/useSessionLifecycle.ts` — polling (lines 258-278), catch-up (line 143)
- `apps/web/src/lib/merge-messages.ts` — `mergeReplace()` function (lines 110-137)
- `apps/web/src/hooks/useChatWebSocket.ts` — `catchUpMessages()` (lines 214-221)
- `packages/shared/src/constants/sam.ts` — `DEFAULT_SAM_HISTORY_LOAD_LIMIT = 200`

### Root Cause Commit
- `091f2b67` (PR #874, May 1 2026) changed the default from `Math.min(parseInt(limit || '1000', 10), 5000)` to `getSessionMessageLimit()` which uses `DEFAULT_SAM_HISTORY_LOAD_LIMIT` (200).

### Merge Strategy Issue
- `mergeReplace()` builds a new map from ONLY the incoming messages, then preserves unconfirmed optimistic messages. ALL earlier-loaded messages that aren't in the incoming set are LOST.
- Both polling and catch-up use `replace` and reset `hasMore`, so any previously-loaded earlier messages vanish.

## Implementation Checklist

- [ ] Add `DEFAULT_CHAT_SESSION_MESSAGE_LIMIT` constant (3000) in `packages/shared/src/constants/`
- [ ] Add `CHAT_SESSION_MESSAGE_LIMIT` env var support
- [ ] Update `getSessionMessageLimit()` in `chat.ts` to use the new constant instead of `DEFAULT_SAM_HISTORY_LOAD_LIMIT`
- [ ] Fix `mergeReplace()` in `merge-messages.ts` to preserve messages from `prev` that are older than the incoming window
- [ ] Remove `setHasMore` from polling fallback — polling should not reset pagination state
- [ ] Remove `setHasMore` from WebSocket `onCatchUp` — catch-up should not reset pagination state
- [ ] Add/update tests for `mergeReplace()` preserving earlier messages
- [ ] Add test for `getSessionMessageLimit()` using the new constant
- [ ] Update CLAUDE.md recent changes if needed

## Acceptance Criteria

- [ ] Default chat session message limit is 3000 (not 200)
- [ ] Chat session limit is configurable via `CHAT_SESSION_MESSAGE_LIMIT` env var
- [ ] After clicking "Load earlier messages", the loaded messages persist through poll cycles
- [ ] WebSocket reconnect catch-up does not discard earlier-loaded messages
- [ ] `hasMore` state is only updated during initial load and explicit loadMore, not during polling/catch-up
- [ ] All existing merge-messages tests pass
- [ ] New tests cover the preserve-earlier-messages behavior

## References

- PR #874: `091f2b67` — the regression commit
- `packages/shared/src/constants/sam.ts` — SAM history limit constants
- `docs/notes/2026-03-17-chat-message-duplication-report.md` — related message handling
