# Self-host: CodexRefreshLock can wedge the same way the GitHub token lock did

## Problem

`CodexRefreshLock` (`apps/api/src/durable-objects/codex-refresh-lock.ts`) serializes OAuth
refreshes on an in-memory promise chain and bounds them with an `AbortController` created inside
the same request. On celld, a caller that disconnects mid-refresh gets its Durable Object event
cancelled and its pending I/O (including that timer) dropped without settling
(`crates/celld/js.rs` `abandon()`, v0.6.3), so the chain never advances and every later Codex
refresh for that user hangs. This is the mechanism behind the T12 GitHub incident, fixed for
`UserAccessTokenLock` in #2653 (waitUntil plus a per-holder deadline checked by waiter-owned
timers). Not observed yet; found by reading the code.

## Acceptance Criteria

- [ ] Apply the #2653 pattern to `CodexRefreshLock` (keep its rotation and grace semantics; rule 45).
- [ ] Tests: an abandoned holder whose timers never fire, healthy overlapping refreshes never overlap,
      single takeover, late-waking holder cannot release its successor.
