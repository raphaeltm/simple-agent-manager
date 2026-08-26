# Never Widen a Shared Predicate That Drives an Action

## When This Applies

Any change that adds a case to an existing boolean helper — `isXError`, `shouldY`, `canZ`,
`needsW` — in order to make a **new** call site treat something as expected, matched,
retryable, or ignorable.

It applies with full force when the helper is named after a *condition* (`isContainerUnavailableError`)
but every existing caller uses it to decide an *action* (attempt a recovery). The name reads
like a classifier; the code is a trigger.

## Why This Rule Exists

Background session snapshots race workspace teardown by design: the coordinator starts the
capture, answers `202`, and the workspace is free to stop while the capture is still running.
Losing that race produced `resolve snapshot devcontainer: workspace is not running/recovery
(status: stopped)` — **217 of the 234** vm-agent error incidents in production over six days,
flooding the private triage queue until it exhausted its diagnosis budget.

The first cut of the fix silenced it in the obvious place: it added
`"workspace is not running/recovery"` to `isContainerUnavailableError`, then asked that helper
whether the snapshot failure was worth reporting.

But that helper had four callers, and three of them were not asking a question — they were
deciding whether to run `recoverWorkspaceRuntime`:

- `websocket.go:222` — terminal session create failed
- `websocket.go:504` — multi-terminal session create failed
- `agent_ws.go:338` — SessionHost container resolve failed

So a one-line change to quiet a log turned "this workspace was deliberately stopped" into
"attempt to rebuild this workspace" at three unrelated sites. The blast radius happened to be
zero — those three only ever see errors minted by `pty.Manager.CreateSessionWithID`
(`devcontainer not available: %w`) or the container resolver (`no running devcontainer found`),
never the `git.go` text — but nothing in the code, the tests, or the diff said so. It was luck,
and the next error path to reach both sites would have spent it.

## Class of Bug

**A predicate reused across a semantic boundary, where the reuse is invisible in the diff.**

Adding one `||` line looks local and additive. It is neither: it is an edit to every caller,
and callers do not appear in the diff. This is `.claude/rules/63` (widening a column deletes
the checks that used it) at the level of a function rather than a schema, and the enumeration
duty of `.claude/rules/44` applied to readers rather than writers.

The tells:

- A helper gains a case for a caller that was added later than the helper.
- The helper's name describes a state, but every call site reads
  `if helper(err) { <do something> }` rather than using the answer as data.
- The new caller wants the predicate to mean "expected / benign / ignorable"; the old ones
  want it to mean "act now".
- The justification is about the *new* call site only, and the PR body never names the others.

## Hard Requirements

1. **Enumerate every caller before adding a case, and record them in the PR.** Not "I grepped"
   — list them, and state per caller whether the new case changes what it does. A helper with
   one caller is a helper; a helper with four is an interface.

2. **Classify the helper as a classifier or a trigger.** If callers branch into an action —
   recover, retry, delete, escalate, skip — it is a trigger. Triggers are never widened to
   serve a classification purpose. Compose a new named predicate that calls the trigger
   instead, so the trigger's meaning is preserved by construction.

3. **Prefer a typed sentinel over a message substring at the boundary you control.** Matching
   `strings.Contains(err.Error(), …)` couples every consumer to wording that no one thinks of
   as an API. Give the producer `var errX = errors.New(…)` and wrap with `%w`; consumers use
   `errors.Is`. Keep the wrapped message byte-identical so operator-facing text does not drift.

4. **Silence requires evidence that nothing is lost.** Before filtering a failure, prove the
   user-visible outcome is unharmed — here, that `session_snapshots` already held a successful
   capture (`sleep_status='sleeping'`, artifact key present, `capture_error IS NULL`) written
   1.2 s before the failure being suppressed. Filter the narrowest set that evidence supports:
   do not fold in `context.DeadlineExceeded`, `context.Canceled`, or other did-not-finish
   errors (`.claude/rules/39`, policy `d08d64dc`).

5. **A sentinel is coarser than the evidence that justified it.** `errors.Is` compares identity
   only — it cannot see the values interpolated into the message. A single
   `errWorkspaceNotRunning` covers `stopped`, `creating`, and `error` alike, so suppressing on
   it silently extends the filter to states nobody measured (a snapshot racing a *restart* is
   not teardown). If the evidence covers one value of a field, carry that field on a typed
   error and branch on it with `errors.As`, and give the states you did NOT validate their own
   must-still-report test.

## Required Tests

- **A no-widening test on the trigger**: assert the trigger returns `false` for the new case
  while the new classifier returns `true`. Verify it goes red when the case is added back to
  the trigger — that is the test that would have caught the original defect.
- **Build the error from its real producer AND through the real wrap.** A literal
  `errors.New("…")` copy of a production message does not exercise the `%w` chain the sentinel
  depends on, so it passes or fails for the wrong reason (`.claude/rules/62`). A test helper
  that *re-implements* the production wrap is the same bug one level up: it keeps passing if the
  real wrap is changed to `%v`, silently disabling the classification. Extract the wrap into a
  named seam both sides call. Assert the producer's message text separately so a reword is
  caught deliberately.
- **A test that decides how long to wait by calling the function under test is circular.** Pass
  the expectation in from the caller instead, and give an absence assertion a settle window so
  "nothing was sent" cannot mean "we sampled too early".
- **A discriminating control per suppressed case**: at least one materially-failing error that
  must still report. Verify the suppression is discriminating by removing it and confirming
  exactly the expected cases go red.
- **An absence assertion needs a liveness assertion beside it** (`.claude/rules/62`): "no
  incident was raised" is also satisfied by the reporter never running. Assert the
  generation-scoped failure callback still fired in the same test.

## Quick Compliance Check

- [ ] Every caller of the widened helper is listed in the PR, with its per-caller impact
- [ ] The helper is a classifier, or a new predicate was composed instead of widening a trigger
- [ ] Message-substring matching was replaced by a typed sentinel at the producer
- [ ] The wrapped message text is unchanged and pinned by a test
- [ ] Suppression is backed by evidence that no user-visible state is lost
- [ ] Timeouts, cancellations, and other did-not-finish errors are excluded from the suppression
- [ ] The sentinel is no coarser than the evidence; unvalidated states have must-still-report tests
- [ ] Tests go through the production wrap seam, not a re-implementation of it
- [ ] No wait condition calls the function under test
- [ ] The no-widening test was verified to go red when the widening is restored

## References

- Task: `tasks/archive/2026-08-26-suppress-stopped-snapshot-incident-noise.md`; PR #1924
- Implementation: `packages/vm-agent/internal/server/session_snapshot_coordinator.go`
  (`isSnapshotTeardownRaceError`), `internal/server/git.go` (`errWorkspaceNotRunning`,
  `errWorkspaceRuntimeNotFound`), `internal/server/workspace_provisioning.go`
- `.claude/rules/63-widening-a-table-can-delete-an-auth-check.md` — the schema-level sibling
- `.claude/rules/44-dual-write-migration-enumerate-writers.md` — enumerate every path
- `.claude/rules/24-no-duplicate-ui-controls.md`, `.claude/rules/59-understand-before-adding.md`
- `.claude/rules/39-debug-before-redesign.md` — measure before silencing
- `.claude/rules/62-tests-must-observe-the-real-trigger.md` — build the error from its producer
- `.claude/rules/47-control-loop-io-budget.md` — a flooded queue exhausts its diagnosis budget
