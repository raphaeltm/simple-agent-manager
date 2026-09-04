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

## The Compare-And-Set Sibling: A Guard Column With Other Writers

The capture pattern above usually lands as a compare-and-set — "only act if the
state has not moved since I observed it". That CAS is only as correct as the
column it compares. **Enumerate every writer of the guard column before you
choose it** (`.claude/rules/44`), and reject any column an unrelated path also
writes.

`recordTurnEnd` guarded a cancel on `session_state.activity_at`, intending "has a
NEW turn begun since I observed the turn-end evidence?". But `activity_at` is a
LAST-REPORT clock: `refreshWorkingActivityForChatSession` rewrites it to `now` on
every persisted message while a turn is working. So a message flushing inside the
cancel's VM round-trip pushed it past `observedAt`, the CAS silently no-opped,
and the turn-end fan-out never ran — wedging the stop button, durable-message
delivery and idle scheduling together (`.claude/rules/57`). The user-visible
symptoms were "Interrupt needs several presses" and "follow-ups stop working
after an interrupt".

The guard column must answer the question the caller is actually asking:

| The question | The column | NOT |
|---|---|---|
| Has a new EPISODE begun? | the episode's own start (`prompt_started_at`, an epoch, a generation counter) | a last-activity/last-report timestamp |
| Has this ROW changed since I read it? | the exact value read at selection time | anything an unrelated path also advances |

Two callers asking different questions must say so explicitly. Do not let one of
them inherit the other's predicate by default — that is `.claude/rules/67` at the
predicate level.

**Required test.** The regression test must DRIVE THE REAL WRITER of the guard
column, not seed the column. Seeding it is what let this ship with green CAS
tests: every existing test set `activity_at` directly, so none could observe that
message persistence moves it. Call the production writer, assert the precondition
it created, then assert the CAS still fires.

**Required inventory.** When a shared helper gains a REQUIRED field, its callers
include test files. `apps/api/tsconfig.json` excludes `tests/`, so TypeScript
will not tell you: a required-field addition type-checks clean and fails at
runtime. Grep for every call site, tests included, and reconcile the full suite
total against a baseline rather than trusting a wrapper's exit code
(`.claude/rules/02` — a pnpm/turbo exit code is not the suite's result; read the
JSON reporter's own `success` field).

## Quick Compliance Check

Before merging a change to a long async operation with a deferred handler:
- [ ] Handler prerequisites are captured at operation start, under the cleanup lock
- [ ] Handler merges live-first, captured-as-fallback (not blind captured use)
- [ ] Captured-state fallback is scoped to the active episode only
- [ ] Unrecoverable path is explicit + sanitized-diagnostic, never a silent stall
- [ ] Regression test clears live state after capture and is proven discriminating
- [ ] Every writer of any CAS guard column is enumerated; no unrelated path writes it
- [ ] The guard column answers the caller's actual question (episode start vs row-unchanged)
- [ ] The regression test drives the real writer of that column rather than seeding it
- [ ] A newly-required field on a shared helper was grepped for in `tests/` too

## References

- Task: `tasks/active/2026-06-15-codex-acp-midprompt-disconnect.md`
- Idea: `01KVQAAPSZQAAM85FZYQHVNRNV`
- `.claude/rules/45-durable-object-concurrency-mutex.md` — the DO `await`-interleaving analogue
- `.claude/rules/46-vm-agent-diagnostic-getter-sync.md` — the goroutine field-sync analogue
- `.claude/rules/11-fail-fast-patterns.md` — identity validation + explicit failure at boundaries
- `.claude/rules/44-dual-write-migration-enumerate-writers.md` — enumerate every writer
- `.claude/rules/57-write-only-cross-boundary-state.md` — the three consumers that wedge together
- `.claude/rules/67-shared-predicates-that-trigger-actions.md` — two callers, two questions
- Task: `tasks/active/2026-09-03-session-stop-cancel-flow-fixes.md` (the CAS-clock incident)
