# Post-Mortem: Disappearing Messages in Project Chat

## What Broke

When loading a project chat session, messages appeared briefly then disappeared. Users saw their conversation history flash on screen before being replaced with "Waiting for messages..." or "No messages in this session."

## Root Cause

Commit `c64ee4c7` ("fix: TDF message relay — agent output reaches chat UI") removed the `wasReconnect` guard in `useChatWebSocket.ts`. This guard controlled whether `catchUpMessages()` fired on WebSocket connect:

```typescript
// BEFORE c64ee4c7 (correct):
const wasReconnect = hadConnectionRef.current;
hadConnectionRef.current = true;
if (wasReconnect) {
  void catchUpMessages();
}

// AFTER c64ee4c7 (broken):
hadConnectionRef.current = true;
void catchUpMessages(); // Fires on every connect, including initial
```

The catch-up on initial connect raced with `loadSession()` in `ProjectMessageView.tsx`. Both called the same API endpoint (`getChatSession`), but the catch-up's `onCatchUp` callback used a `replace` merge strategy that could overwrite freshly-loaded messages.

## Timeline

- **c64ee4c7**: Guard removed, catch-up fires on every connect
- **Same PR**: Behavioral test updated to expect catch-up on initial connect (documenting the bug as intended behavior)
- **Subsequent PRs**: Multiple message dedup and merge strategy changes built on the assumption that catch-up always fires
- **2026-03-23**: User reports messages disappearing when loading chat sessions

## Why It Wasn't Caught

1. **Tests were updated to document the bug, not reject it.** When `c64ee4c7` removed the `wasReconnect` guard, the behavioral test was changed from expecting 0 catch-up calls on initial connect to expecting 1. The test change was reviewed as part of the same PR and appeared intentional.

2. **The race condition is timing-dependent.** In unit tests with mock WebSockets, the catch-up and loadSession calls resolve synchronously in a deterministic order. The race only manifests in the real Cloudflare environment where network latency introduces genuine asynchrony.

3. **Source-contract test asserted the absence of the guard.** A string-based test (`expect(hookSource).not.toContain('if (wasReconnect)')`) was added to explicitly verify the guard was removed — making it impossible to restore the guard without also updating the test.

## Class of Bug

**Test-documented regression**: A behavioral test was updated to match broken behavior rather than reject the behavior change. The test became a shield protecting the bug from future correction. This is a specific instance of the broader class "tests that verify implementation details instead of behavioral contracts."

## Process Fix

When a test changes from asserting X behavior to asserting Y behavior (e.g., catch-up count changes from 0 to 1), the PR reviewer should ask: "Is this a behavior change or a regression?" The test change should be justified independently of the code change — if the code "needs" the test to change, that's the moment to verify the behavior change is intentional and desirable.

Source-contract tests (`readFileSync` + `toContain`) are particularly dangerous here because they verify code shape, not behavior. The existing rule in `.claude/rules/02-quality-gates.md` (Prohibited Test Patterns) already flags this pattern but wasn't enforced during the `c64ee4c7` review.

## Fix

Restore the `wasReconnect` guard so `catchUpMessages()` only fires on reconnections. Update all three affected tests to expect the correct behavior (0 catch-up calls on initial connect, 1 on reconnect).
