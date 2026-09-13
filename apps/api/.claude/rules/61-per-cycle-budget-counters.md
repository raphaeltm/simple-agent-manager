# Per-Cycle Budget Counters Must Reset on Success

## When This Applies

Any counter that **gates access to an operation** (retry budgets, attempt limits,
failure counts) and where the gated operation can succeed and then be retried in
a later cycle (sleep/wake, reconnect, retry-after-backoff).

## Why This Rule Exists

`session_snapshots.recovery_attempts` was incremented on every wake claim but
never reset to 0 on successful completion. After 3 sleep/wake cycles the
`WHERE recovery_attempts < 3` predicate permanently rejected all future claims,
bricking sessions that had never had a single failed wake. The adjacent
`sleepAttempts` field WAS correctly reset — the pattern existed in the same
function; one field just forgot to follow it.

## Class of Bug

**A budget counter that accumulates across success boundaries.** The counter is
meant to cap consecutive failures, but because it never resets, it silently
becomes a lifetime cap. The bug is invisible for low-frequency users and only
manifests after N successful cycles — exactly when the system should be most
confident the operation works.

## Hard Requirements

1. **Every counter that gates access MUST reset to its initial value when the
   gated operation succeeds.** If `sleepAttempts` resets to 0 on successful
   sleep, `recoveryAttempts` must reset to 0 on successful wake. Symmetric
   operations get symmetric resets.

2. **If a counter is intentionally a lifetime budget** (e.g. trial usage caps),
   document that intent in a code comment adjacent to the counter and in the
   migration that creates the column. Undocumented lifetime counters are bugs.

3. **When adding a new attempt counter, locate every success path for the gated
   operation and add the reset in the same PR.** Do not leave "add the reset
   later" as a follow-up — the follow-up will not happen.

4. **Check sibling counters.** When you see one counter being reset in a success
   path, check whether adjacent counters on the same row also need resetting.

## Required Tests

A regression test that runs N+1 cycles (where N is the budget) and asserts the
(N+1)th cycle succeeds. The test MUST fail on code where the reset is missing.

## Quick Compliance Check

- [ ] Every attempt/retry counter that gates a WHERE clause resets on success
- [ ] Lifetime-budget counters are documented as intentional
- [ ] Sibling counters on the same row were checked for the same pattern
- [ ] A multi-cycle regression test exists and was verified discriminating

## A Budget Whose Only Reset Is Success Becomes a Lifetime Cap When the Failures Are Exogenous

The rule above assumes the gated operation can succeed on its own merits, so a
reset-on-success is enough. That assumption breaks when the operation is gated by
a counter that **failures outside the operation's control** also spend.

`session_snapshots.recovery_attempts` caps wake attempts at 3 and resets to 0 on a
successful wake — rule-61-compliant as written. But a wake is "restore a verified
snapshot onto a freshly provisioned VM", and provisioning fails for reasons that
say nothing about the snapshot: provider capacity, DNS, a node vanishing mid-boot.
Each of those spent a permanent slot. On 2026-09-09 session `516141ed` burnt all
three inside **34 minutes** on the _same_ `hetzner API error (412): error during
placement`, and four production sessions ended up holding complete, unexpired
snapshots they could never reach again. One of the four failed with
`Provisioned node ... disappeared during node_agent_ready. Retry the task to
provision a replacement.` — the message instructed a retry the system had already
made impossible.

The counter reset on success. Success had simply become unreachable, so the reset
was dead code and the cap was a lifetime cap in every way that mattered.

### The tells

- The budget's failures include a class the operation does not control — provider
  capacity, DNS, quota, a peer restarting, a network partition.
- The only writes that reset the counter sit _after_ the gated operation
  succeeds, or on a path the gated resource can no longer reach (here: a fresh
  capture or a fresh sleep transition, neither reachable while already asleep).
- A retry burst is bounded by a **count** with no notion of elapsed time, so N
  failures in one minute are indistinguishable from N failures over a week.
- The failure text or the UI tells the user to retry.

### Hard requirements

1. **Enumerate what can spend the budget before choosing its shape.** If any
   spender is exogenous — a transient failure of a dependency, not evidence about
   the gated resource — a bare count is the wrong shape.

2. **Prefer a burst budget to a lifetime cap.** A cap exists to stop a hot loop,
   so bound the retry _rate_: N attempts per window, released by elapsed time.
   Name the absolute escape separately (a TTL, an expiry, an operator action) so
   the work still cannot be retried forever (`.claude/rules/47`).

3. **Release the budget only on positive evidence, never on absence.** A cleanly
   reported failure may age out; an attempt that never reported back must keep its
   slot, or a crashed attempt launders itself into unlimited retries. `NULL` is
   "no evidence", and it fails closed.

4. **Widening a resumer widens every mirror of it.** A budget that gates "is this
   still recoverable?" is almost always mirrored by a destroyer, a sweep, and a
   display path. Enumerate them and move them together, or the sweep terminalizes
   work the resumer would still recover (`.claude/rules/58`, `.claude/rules/44`).

5. **Existing rows need the new escape too.** A decay anchored on a column that
   did not exist yesterday leaves every already-stranded row stranded. Backfill it
   (`.claude/rules/71`).

### Required tests

- **The incident**: a spent budget plus an aged clean failure is claimable again,
  driven through the real writers. Must fail pre-fix.
- **The control**: the same budget spent inside the window is still refused — else
  the suite passes with the cap deleted outright.
- **No-evidence**: an attempt that never reported back does not release the budget.
- **The next burst is bounded**: a claim taken under decay restarts the count
  rather than continuing it, so the cap still applies to the following burst.
- **Every mirror**: one test per consumer proving it agrees with the resumer, each
  with its own refusal control.
- **The backfill**: a row stranded by the old shape recovers; a row that never
  failed gains no anchor.

## References

- Task: `tasks/active/2026-09-10-wake-attempt-budget-strands-sessions.md`
- Implementation: `apps/api/src/services/session-snapshot-recovery-budget.ts`
- `.claude/rules/72-error-categories-must-match-the-recovery-action.md` — the
  sibling: categorising an error by the provider's vocabulary rather than by what
  the caller must do about it
- `.claude/rules/58-terminal-verdicts-must-match-the-resumer.md` — the destroyer
  must read what the resumer reads
- `.claude/rules/71-tightening-a-column-can-delete-a-capability.md` — existing
  rows need the escape too
- `.claude/rules/47-control-loop-io-budget.md` — bounded escape paths
