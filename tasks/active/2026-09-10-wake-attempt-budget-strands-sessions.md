# Wake attempt budget permanently strands sessions after transient infra failures

**Status:** in progress
**Branch:** `sam/use-sam-mcp-tools-33yj1h`

## Problem

Four production sessions hold complete, unexpired snapshots
(`status='available'`, `degradation='none'`, `sleep_status='sleeping'`) that can
never be woken again. A message to any of them returns
`Target workspace is sleeping (recovery_attempts_exhausted)`.

`session_snapshots.recovery_attempts` caps wake attempts at
`SESSION_SNAPSHOT_RECOVERY_MAX_ATTEMPTS` (default 3). It was consumed identically
by failures that prove a snapshot cannot be restored and by transient
infrastructure failures that never reached the snapshot at all:

| chat session | attempts | recovery_error                                                                                         |
| ------------ | -------- | ------------------------------------------------------------------------------------------------------ |
| `516141ed`   | 3        | `hetzner API error (412): error during placement`                                                      |
| `b176e912`   | 3        | `hetzner API error (412): error during placement`                                                      |
| `813752af`   | 3        | `Provisioned node ... disappeared during node_agent_ready. Retry the task to provision a replacement.` |
| `3f38dfc4`   | 3        | `Backend DNS record creation failed: Authentication error`                                             |

`516141ed` is the session Raphaël tried to wake on 2026-09-09. It burnt all three
attempts between 12:03Z and 12:37Z on the _same_ transient condition — the 412
placement bug fixed by PR #2052. Merging that fix does not bring the session back.
`813752af`'s error text instructs a retry the system had already made impossible.

Every write that resets `recovery_attempts` to 0 requires a successful wake
(`completeSessionSnapshotRecovery`, `markSessionSnapshotAwakeInPlace`), a fresh
capture (`prepareSessionSnapshot`), or a fresh sleep transition
(`markSessionSnapshotSleeping`). A sleeping session that cannot wake reaches none
of them, and there is no admin or user escape hatch.

## Root cause

The cap exists to stop a hot wake loop, but it was expressed as a **count with no
notion of elapsed time**, so three failures in 34 minutes are indistinguishable
from three failures over a week. Because provisioning failures are exogenous to
the snapshot, the reset-on-success required by `.claude/rules/61` was unreachable
and the burst budget behaved as a lifetime cap.

## Fix

Make the budget a **decaying burst budget**: `maxAttempts` failures per
`SESSION_SNAPSHOT_RECOVERY_ATTEMPT_DECAY_MS` window (default 15 min) instead of
`maxAttempts` ever. `session_snapshots.expires_at` (7 days) remains the absolute
escape path. Wakes are triggered by prompt delivery rather than by a sweep, but
that is not the same as "bounded by user action": a single queued prompt retries
itself up to `PROMPT_DELIVERY_MAX_ATTEMPTS` (5) with backoff, which is exactly
how one user action produced three attempts in 34 minutes in the incident. The
worst case is therefore `maxAttempts` per decay window for as long as something
keeps addressing the session — see "Known tradeoff" below.

- New column `session_snapshots.recovery_failed_at`, written by **both** writers
  of `recovery_status='failed'` — `failSessionSnapshotRecovery` and
  `failAndRestoreSessionRecoveryHandoff` (the raw-SQL batch reached from
  `ensureSessionRecovery`'s generic catch) — and cleared by every path that
  resets `recovery_attempts`. The first cut of this fix maintained only the
  former; review caught it, and
  `session-snapshot-failed-writer-coverage.test.ts` now scans the source so the
  pair cannot drift apart again.
- New module `session-snapshot-recovery-budget.ts` holds the single definition,
  in both TypeScript and SQL, so no consumer can drift.
- A claim taken under decay restarts the count at 1 and clears the anchor, so the
  cap still bounds the following burst.
- `recovery_failed_at IS NULL` (an attempt that never reported back) deliberately
  does NOT release the budget — a crashed claim must not launder itself into
  unlimited retries.

## Consumers enumerated (`.claude/rules/44`, `.claude/rules/58`)

Every mirror of `recovery_attempts < maxAttempts` moved with the resumer:

| Consumer                                        | Role                                           | Change                                                                   |
| ----------------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------ |
| `claimSessionSnapshotRecovery`                  | resumer — authorizes the wake                  | decaying predicate + burst restart                                       |
| `hasRestorableSleepingSessionSnapshot`          | "is there a wakeable snapshot?"                | shared SQL predicate                                                     |
| `restorableOrInFlightSleepSnapshotPredicateSql` | sleep/ledger reconciliation                    | shared SQL predicate                                                     |
| `isSessionResumable` (`task-runtime-liveness`)  | destroyer — stuck-task + ProjectData DO sweeps | shared TS predicate, decay threaded through `TaskRuntimeLivenessSignals` |
| `deriveAgentActivityState`                      | display — "is this session sleeping?"          | shared TS predicate                                                      |

## Checklist

- [x] Migration `0155_session_snapshot_recovery_failed_at.sql` (additive + backfill)
- [x] `recoveryFailedAt` on the drizzle schema
- [x] Shared budget module (TS + SQL halves of one rule)
- [x] Resumer, both SQL predicates, destroyer, and display path moved together
- [x] Sibling reset at all four `recoveryAttempts: 0` sites (`.claude/rules/61`)
- [x] `SESSION_SNAPSHOT_RECOVERY_ATTEMPT_DECAY_MS` in `env.ts` + `.env.example`
- [x] Discriminating tests, verified red on a surgical revert
- [x] Migration backfill test (`.claude/rules/71`)
- [x] Process fix: `.claude/rules/61` gains the exogenous-failure class
- [x] Second writer of `recovery_status='failed'` fixed + machine-checked scan
- [x] Operator-visible warn when a spent burst is restarted
- [x] Local specialist review findings addressed
- [ ] CI green

## Known tradeoff (tracked, not fixed here)

The decay bounds retry RATE, not aggregate spend, and nothing in the wake path
classifies WHY a wake failed. A snapshot that is genuinely unrestorable
(corrupt manifest, incompatible agent build) is now retried on the same terms as
a transient placement error: up to `maxAttempts` real provisioning attempts per
decay window, for as long as something keeps addressing the session, until
`expires_at`. That is strictly better than the incident behaviour — which
destroyed access to _restorable_ sessions — but it is a real change in cost
exposure, so it is stated rather than buried.

Two things bound it today: `expires_at`, and the fact that automatic retries stop
once a queued prompt exhausts its own 5 delivery attempts. A new
`session_recovery.attempt_budget_burst_restarted` warn makes a session that keeps
restarting bursts visible to operators (`.claude/rules/47` §9).

Deliberately NOT fixed by adding a lifetime burst cap: that would re-create the
stranding bug at a higher threshold, which is precisely what
`.claude/rules/61` now warns against. The right fix is failure classification —
charge the budget only for failures that implicate the snapshot
(`.claude/rules/72`) — which is a larger change than this incident fix should
carry. Tracked as idea `01M24EJBYD9HZMFPXSJV2KZ0W5`.

## Post-mortem

**What broke.** Four sessions with valid snapshots became permanently unwakeable.
Raphaël hit it directly: he woke `516141ed`, watched three provisioning attempts
fail on the same transient provider error, and the session was gone for good.

**Root cause.** A retry budget shaped as a lifetime count while the failures
spending it were exogenous to the operation being retried.

**Timeline.** `3f38dfc4` stranded 2026-09-03, `813752af` 2026-09-08, `b176e912`
and `516141ed` 2026-09-09. Found 2026-09-10 while auditing sleep after the PR
#2052 investigation.

**Why it wasn't caught.** `.claude/rules/61` was satisfied on its face — the
counter does reset on success — and the exhausted state was documented as a
deliberate bounded escape in `task-runtime-liveness.ts`. Nothing asked whether
success was still reachable, and no test ran more than one burst of failures.
The tests that existed asserted the cap held, which it did.

**Class of bug.** A budget counter whose only reset is success, gating an
operation whose failures are largely exogenous — so the reset is unreachable and
the burst cap silently becomes a lifetime cap.

**Process fix.** `.claude/rules/61` gains "A Budget Whose Only Reset Is Success
Becomes a Lifetime Cap When the Failures Are Exogenous", with the tells, the
burst-budget requirement, the fail-closed-on-absence requirement, the
enumerate-every-mirror requirement, and the backfill requirement.

## Production recovery

The migration's backfill restores the four stranded rows: each already carries a
terminal-failure `updated_at` far older than any decay window, so the next
prompt to those sessions claims a wake normally. Three expire 2026-09-15/16;
`3f38dfc4` expires 2026-09-10T05:22Z and will likely lapse before the deploy.
