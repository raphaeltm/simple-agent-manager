# Fix Disappearing Messages in Project Chat

## Problem

When loading a project chat session, messages appear briefly then disappear. This was introduced by commit `c64ee4c7` which removed the `wasReconnect` guard in `useChatWebSocket.ts`, causing `catchUpMessages()` to fire on every WebSocket connection (including the initial one), not just reconnections.

## Root Cause

In `apps/web/src/hooks/useChatWebSocket.ts`, the `onopen` handler calls `catchUpMessages()` unconditionally. Before `c64ee4c7`, there was a guard:

```typescript
// BEFORE (correct):
const wasReconnect = hadConnectionRef.current;
hadConnectionRef.current = true;
if (wasReconnect) {
  void catchUpMessages();
}

// AFTER (broken):
hadConnectionRef.current = true;
void catchUpMessages(); // Always fires, including initial connect
```

The catch-up calls `getChatSession()` and applies a `replace` merge strategy via `onCatchUp`, which replaces all existing messages. On initial connect, this races with `loadSession()` in `ProjectMessageView.tsx` — both call the same API endpoint, but the `replace` strategy can overwrite freshly-loaded messages if the catch-up response arrives at a bad time or with slightly different data.

## Research Findings

- `useChatWebSocket.ts:106-118` — `onopen` handler calls `catchUpMessages()` unconditionally
- `ProjectMessageView.tsx:380-383` — `onCatchUp` callback uses `mergeMessages(prev, catchUpMessages, 'replace')`
- `ProjectMessageView.tsx:455-475` — `loadSession()` sets messages directly via `setMessages(data.messages)`
- `merge-messages.ts:85-112` — `mergeReplace()` replaces all non-optimistic messages with incoming
- `useChatWebSocket.behavioral.test.ts:265-271` — test expects catch-up on initial connect (documents buggy behavior)

## Implementation Checklist

- [ ] Restore `wasReconnect` guard in `useChatWebSocket.ts` `onopen` handler
- [ ] Update `useChatWebSocket.behavioral.test.ts` to expect 0 catch-up calls on initial connect and 1 on reconnect
- [ ] Verify the fix doesn't break reconnection catch-up behavior
- [ ] Run `pnpm typecheck && pnpm lint && pnpm test` to confirm no regressions

## Acceptance Criteria

- [ ] Loading a project chat session shows messages and they persist (don't disappear)
- [ ] Reconnecting after a disconnect still catches up on missed messages
- [ ] Multiple back-and-forth messages in a project chat work correctly on staging
- [ ] Existing chat message tests pass
