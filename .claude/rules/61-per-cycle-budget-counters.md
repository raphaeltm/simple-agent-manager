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
