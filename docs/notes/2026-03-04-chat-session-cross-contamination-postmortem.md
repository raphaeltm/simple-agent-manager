# Chat Session Cross-Contamination Post-Mortem

## What broke

Messages from one project chat session appeared in another session's feed. Users switching between sessions in the project chat UI would see messages from the wrong session, or messages from a previous task would appear in a new task's session after warm node reuse.

## Root cause

Three independent bugs at different layers:

1. **Web UI polling race (primary):** The polling fallback `useEffect` in `ProjectMessageView.tsx` used `setInterval` to fetch session data every 3s. When the user switched sessions, the cleanup function cleared the interval but did NOT abort in-flight HTTP requests. A response for session A could resolve after switching to session B and call `setMessages(data.messages)` with session A's data. Introduced with the initial polling implementation.

2. **VM agent outbox stale messages:** The message reporter is a singleton per VM. When a warm node was reused for a new task, `SetSessionID()` updated the in-memory field but left unsent messages in the SQLite outbox tagged with the old session ID. The flush loop reads all messages without session filtering and delivers them to the new workspace's endpoint.

3. **VM agent flush/clear race:** `SetSessionID()` updated the session ID and then cleared the outbox, but the flush loop could fire between those two operations — reading stale messages after the session ID was updated but before the outbox was cleared.

## Timeline

- Feature built: Initial polling implementation and message reporter were part of the task-chat architecture (spec 021/022)
- Bug discovered: 2026-03-04 — user observed messages from one session appearing in another
- Investigation: Same day — traced through API, WebSocket, and VM agent layers
- Fix merged: Same day

## Why it wasn't caught

1. **No session-switching tests existed.** All existing tests tested a single session in isolation. No test simulated switching between sessions and verifying message isolation.
2. **No in-flight abort testing.** The polling effect cleanup was never tested to verify it cancels pending requests.
3. **No warm node reuse tests for message isolation.** The outbox reporter tests verified enqueue/flush mechanics but never tested what happens to the outbox during a session switch.
4. **The flush serialization gap was invisible to the race detector.** The race exists at the SQLite layer (stale rows read between session ID update and outbox clear), not in Go memory, so `go test -race` could not detect it.

## Class of bug

**Stateful singleton cross-contamination during context switch.** When a shared stateful component (polling effect / singleton reporter) is reused across different logical contexts (chat sessions), residual state from the old context (in-flight requests / outbox rows) leaks into the new context.

## Process fix

No process rule changes needed for this PR — the existing rules in `.claude/rules/02-quality-gates.md` already require regression tests that "would have caught the bug" and capability tests across system boundaries. The rules were not followed during the original implementation. The regression tests added in this PR close the gap.
