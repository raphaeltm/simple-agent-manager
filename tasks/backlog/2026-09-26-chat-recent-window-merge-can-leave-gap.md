# Chat recent-window refreshes can leave a hole in the loaded transcript

## Problem

Two web refresh paths fetch only the newest page of a session and merge it with `mergeMessages(..., 'replace')`:

- the degraded fallback poll, `pollActiveSession` in `apps/web/src/components/project-message-view/useSessionLifecycle.ts` (`limit: DEFAULT_CHAT_SESSION_MESSAGE_LIMIT`, 500);
- the WebSocket reconnect catch-up, `catchUpMessages` in `apps/web/src/hooks/useChatWebSocket.ts` (same limit).

`mergeReplace` (`apps/web/src/lib/merge-messages.ts`) keeps every loaded row older than the window and adds the window. If more than 500 messages were persisted after the newest loaded row — a hidden tab with the socket down during a busy turn — the rows between the two are in neither set. Nothing fills them later: the cached-transcript refresh (`refreshCachedTranscript` in `apps/web/src/lib/message-paging.ts`) reads forward from the newest persisted row, which is now past the hole, and "Load earlier messages" reads backward from the oldest. A page reload shows the full transcript, so this is display loss, not data loss.

## Context

Found while reviewing the exact-cursor pagination fix (branch `sam/fix-silent-transcript-loss-rtg8mb`). That change made the cached refresh drain forward completely; these two recent-window paths are separate and pre-existing.

## Acceptance Criteria

- [ ] When a recent-window response does not reach back to the newest persisted row already loaded, the client drains forward from that row (`refreshCachedTranscript`) instead of merging a window with a hole.
- [ ] A rendered test loads a transcript, persists more than one window of newer rows while the socket is down, triggers the poll or reconnect catch-up, and asserts every row is present and in order; it fails against the current `replace` merge.
