# Capture Handler Prerequisites Before a Long Async Operation

## When This Applies

This rule applies whenever a **deferred completion/error/recovery handler** reads
mutable instance state that a **concurrent cleanup path** can clear between the
start of a long async operation and the moment the handler runs. The canonical
example is `HandlePrompt` in the vm-agent ACP session host: the blocked ACP
`Prompt` RPC can take minutes, and `finishPromptWithError` (its error handler)
needs the ACP session ID, agent type, and LoadSession capability to begin crash
recovery — but a concurrent `monitorProcessExit` can clear those live fields when
the agent process exits mid-prompt.

## Why This Rule Exists

The recurring production `-32603 "peer disconnected before response"` terminal
task failures were caused by exactly this race. `finishPromptWithError` read the
**live** `h.sessionID` / `h.agentSupportsLoadSession` at handler time. When the
process exited mid-prompt, `monitorProcessExit` cleared those fields *before* the
blocked `Prompt` returned the peer-disconnect error, so a fully recoverable
LoadSession-capable prompt was mis-classified as unrecoverable and terminally
failed. The live read looked correct; the bug only manifested under the
process-exit-then-error ordering. See
`tasks/active/2026-06-15-codex-acp-midprompt-disconnect.md` and idea
`01KVQAAPSZQAAM85FZYQHVNRNV`.

## Class of Bug

**Deferred handler reads live mutable state that a concurrent cleanup clears.**
The handler's decision (recover vs. fail, retry vs. abort, resume vs. restart)
depends on state that is only guaranteed valid at operation start, not at handler
time. Any long-running operation whose completion/error handler runs after a
sibling goroutine may have torn down shared state is in this class:
prompt/turn handlers, upload/download completion callbacks, reconnect handlers,
lifecycle-transition callbacks.

## Hard Requirements

1. **Capture the handler's prerequisites at operation start**, before dispatching
   the long async call, under the same lock that a concurrent cleanup would take.
   Store them alongside the operation (e.g., threaded through the handler's
   argument struct), not by re-reading live fields in the handler.

2. **Merge live-first, captured-as-fallback.** At handler time, prefer the live
   value when still present (it is the most current), and fall back to the
   captured snapshot only for fields that have been cleared. Do not blindly use
   the captured value if the live one is valid.

3. **Scope any captured-state fallback to the episode it belongs to.** A captured
   identifier used to resume/recover must only be consulted while that
   recovery/episode is active (e.g. `inProgress`), never on an unrelated path such
   as a user cancel, so a stale captured value cannot leak into the wrong restart.

4. **Keep the truly-unrecoverable path explicit and diagnosable.** When even the
   captured prerequisites are absent, fail terminally with a sanitized diagnostic
   naming exactly which prerequisites were missing — never a silent stall, never a
   leaked secret/identifier value.

## Required Tests

- A regression test that **clears the live fields after capture** and asserts the
  handler still takes the recover/continue path using the captured snapshot. It
  must be discriminating: verify it fails when the capture/fallback is removed.
- A test proving the resumed episode uses the **captured identifier** (e.g. the
  LoadSession target equals the prompt-start session ID), not a fresh/wrong one.
- Per-prerequisite terminal-diagnostic tests: each prerequisite missing in
  isolation, and all missing together, asserting the diagnostic names exactly the
  absent ones without leaking their values.
- A negative assertion that no recovery/episode state is left armed on the
  terminal path (so a watchdog cannot fire a second completion).

## Quick Compliance Check

Before merging a change to a long async operation with a deferred handler:
- [ ] Handler prerequisites are captured at operation start, under the cleanup lock
- [ ] Handler merges live-first, captured-as-fallback (not blind captured use)
- [ ] Captured-state fallback is scoped to the active episode only
- [ ] Unrecoverable path is explicit + sanitized-diagnostic, never a silent stall
- [ ] Regression test clears live state after capture and is proven discriminating

## References

- Task: `tasks/active/2026-06-15-codex-acp-midprompt-disconnect.md`
- Idea: `01KVQAAPSZQAAM85FZYQHVNRNV`
- `.claude/rules/45-durable-object-concurrency-mutex.md` — the DO `await`-interleaving analogue
- `.claude/rules/46-vm-agent-diagnostic-getter-sync.md` — the goroutine field-sync analogue
- `.claude/rules/11-fail-fast-patterns.md` — identity validation + explicit failure at boundaries
