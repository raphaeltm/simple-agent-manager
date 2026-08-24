# Fix: a slept (resumable) session is classified as conclusive runtime death

**SAM task**: `01M074T96YJWVYCJWX6Z0T2E0E`
**Branch**: `sam/fix-production-workspace-reaping-0t2e0e` (PR #1844)
**Status**: archived (landed via PR #1844)

## Problem

Production task-mode sessions are being terminalized as `failed` with
`"Task runtime is conclusively gone after reconciliation grace (workspace_deleted)."`
while their session snapshot is intact, unexpired, and fully resumable.

Two reported kills on 2026-08-16 (21:21Z and 21:36Z), but the audit found this is
**not** a two-off: **31 tasks** have been terminalized with a `workspace_deleted`
reason since 2026-08-06, and it is still occurring (1 on 2026-08-17).

## Audit trail (production D1, evidence-backed — no inference)

Account `e2eb9a8d5b560cce006fdd03ad6f2e49`, DB `sam-prod` / `sam-observability-prod`.

| Session    | Task                         | in_progress | ACP prompt ended               | slept at      | ws → `deleted` | task → `failed` |
| ---------- | ---------------------------- | ----------- | ------------------------------ | ------------- | -------------- | --------------- |
| `da90b7c4` | `01M064S8K7C13GRHCJJ13EJ6E7` | 20:48:02Z   | 20:52:47Z (`end_turn`, 4m28s)  | 21:11:57.499Z | 21:17:14.512Z  | 21:21:05.825Z   |
| `8bd22a42` | `01M064TAJ7B0AX8G115CY85RXM` | 20:43:32Z   | 21:09:57Z (`end_turn`, 26m11s) | 21:26:51.529Z | ~21:31:51Z     | 21:36:06.166Z   |

`session_snapshots` state **at the moment each task was declared "conclusively gone"**:

| Session    | `status`    | `degradation`     | `sleep_status` | `sleeping_at` | `expires_at`   | home R2 key |
| ---------- | ----------- | ----------------- | -------------- | ------------- | -------------- | ----------- |
| `8bd22a42` | `available` | `none`            | `sleeping`     | 21:26:51.529Z | **2026-08-23** | present     |
| `da90b7c4` | `degraded`  | `entries-skipped` | `sleeping`     | 21:11:57.499Z | **2026-08-23** | present     |

Both sessions were resumable for another **7 days** when SAM wrote `failed`.

### Proven causal chain

1. The agent's ACP prompt completes with `end_turn`
   (`vm-agent` → `recordTurnEnd` → `session_state.activity='idle'`). The task stays
   `in_progress` / `execution_step='awaiting_followup'` because the agent has not
   called `complete_task()` yet.
2. The **session-sleep cron** (`runSessionSleepSweep`, `apps/api/src/scheduled/session-sleep.ts:221`)
   finds the session eligible: `isActivitySafeForSleep`
   (`apps/api/src/services/session-sleep.ts:195`) returns `true` on `activity === 'idle'`,
   and `SESSION_SLEEP_AFTER_MS` (default 15 min) has elapsed. **This is intended,
   policy-sanctioned behaviour** ("aggressively sleep idle sessions").
3. `sleepWorkspaceSession` captures the snapshot, sets `workspaces.status='sleeping'`,
   writes `session_snapshots.sleep_status='sleeping'` + `sleeping_at` + `expires_at`,
   then arms `NodeLifecycle.scheduleWorkspaceDeletion` (`session-sleep.ts:610-621`).
4. **5 minutes later** (`WORKSPACE_STOPPED_TTL_MS`,
   `packages/shared/src/constants/node-pooling.ts:100`), the NodeLifecycle alarm runs
   `UPDATE workspaces SET status='deleted' ... WHERE status IN ('stopped','sleeping')`
   (`apps/api/src/durable-objects/node-lifecycle.ts:570-573`).
   **This rewrites the inconclusive `sleeping` marker into the conclusive `deleted` marker.**
   (Timing confirms: `sleeping_at` + 5 min == the workspace row's `updated_at`.)
5. The stuck-task cron classifies the runtime.
   `classifyTaskRuntimeLiveness` (`apps/api/src/services/task-runtime-liveness.ts:102-109`)
   sees `status !== 'running'` and `'deleted'` is not in `INCONCLUSIVE_WORKSPACE_STATUSES`
   (`:53`), so it returns `{ live:false, conclusive:true, reason:'workspace_deleted' }`.
6. `apps/api/src/scheduled/stuck-tasks.ts:988` sees `conclusive && !live` → writes `failed`.

### The core defect

**The classifier and the resumer disagree about what "gone" means.**

`loadRecoveryContext` (`apps/api/src/services/session-recovery.ts:85`) — the code that
actually wakes a slept session — accepts a session as resumable when:

```ts
snapshot.workspaceId && snapshot.projectId === projectId && snapshot.sleepingAt;
```

It **never reads `workspaces.status`**. A workspace row with `status='deleted'` is still
fully wakeable. Meanwhile the classifier's only workspace signal _is_ `workspaces.status`,
and it never reads `session_snapshots`. So the classifier declares conclusive death for
sessions the recovery path would happily restore.

This is precisely the contract in `.claude/rules/02-quality-gates.md`:

> "sleep, wake, restore, replacement, probe failure, and unknown state are inconclusive"

and the class of bug in `.claude/rules/53`: a _turn-level_ signal (`activity='idle'`,
meaning "the ACP prompt ended") and a _status_ signal (`workspaces.status`) being used as
proxies for a question they cannot answer ("is this session's work unrecoverable?").

### Why the original brief's framing needed correcting

The brief attributed the kill to `idle-cleanup.ts` treating chat-silence as idleness, and
proposed making that sweep consult `session_state.activity`. The evidence does not support
that as the proximate cause:

- Both agents had **finished** their ACP turn (`end_turn`) 17–19 min before the sleep. They
  were not "chat-quiet but working" at kill time; they were genuinely between turns.
- Both DO idle sweeps (`processExpiredCleanups` `idle-cleanup.ts:320`,
  `checkWorkspaceIdleTimeouts` `idle-cleanup.ts:548`) route through
  `terminalizeIdleTaskInD1` → `getLocalTaskRuntimeLiveness`, which **preserves** unless the
  shared classifier says conclusively dead. They did not kill these sessions.
- The sleep cron is already activity-aware and will not sleep a `prompting` session.

Every terminalization path — the stuck-task cron _and_ both DO idle sweeps — funnels through
the single shared `classifyTaskRuntimeLiveness`. Fixing it there fixes all three at once
(DRY), instead of bolting separate guards into each sweep.

## Fix

Teach the shared classifier the one thing it is missing: **whether the session is currently
asleep and restorable.**

Add a session-resumability signal to `TaskRuntimeLivenessSignals`. When the workspace row
exists but is not `running`, and the session has a live sleep record, classify as
**inconclusive** (`workspace_<status>_snapshot_resumable`) instead of conclusive death.

Resumability predicate (mirrors the resumer, plus a bound the resumer lacks):

- a `session_snapshots` row exists for this workspace's `chat_session_id`, scoped to the
  same `project_id` **and** `workspace_id` (rule 11: project-scoped reads)
- `sleeping_at IS NOT NULL` — the session was genuinely slept. User deletes destroy the
  snapshot row entirely (`session-snapshot-persistence.ts:42`), so this discriminates
  idle-sleep from user deletion **without needing a new `deleted_reason` column**
- `sleep_status = 'sleeping'` — asleep _now_, not a stale marker from a session that
  already woke
- `expires_at` parses and is in the future — **the bounded escape** (rule 47). Once the
  snapshot expires the session is genuinely unrecoverable and the task fails normally.
  An absent/unparseable expiry counts as NOT resumable, so no task can become immortal.

`workspace_missing` (row absent) stays **conclusive**: `loadRecoveryContext` requires the
workspace row to exist (`session-recovery.ts:91-94`), so a hard-deleted workspace really is
unrecoverable. This boundary is chosen to match the resumer exactly.

Probe-outcome handling: `'not_run'` preserves today's behaviour (no evidence → unchanged);
`'error'` yields inconclusive for the non-running branch only, because the alternative is
destroying a possibly-recoverable session.

## Research findings → checklist mapping

Every finding below has a checklist item or an explicit deferral.

| Finding                                                                                    | Disposition                                                                                       |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| Classifier reads only `workspaces.status`; never `session_snapshots`                       | Item 1, 2                                                                                         |
| `node-lifecycle.ts:571` predicate rewrites `sleeping` → `deleted`                          | Covered by items 1–2 (classifier no longer trusts status alone)                                   |
| `workspaces` has no deletion-cause column                                                  | Not needed — snapshot presence is the discriminator (documented above)                            |
| Two adapters feed the classifier; both must supply the signal                              | Item 3 (rule 44 enumeration)                                                                      |
| `expires_at` is `NOT NULL` in schema and is the natural escape bound                       | Item 1                                                                                            |
| `loadRecoveryContext` ignores `expires_at` — an expired snapshot would still be "restored" | **Deferred** → SAM Idea `01M076660EE6YENQFDK40S4N9P`                                              |
| `cancelStalledPrompt` bypasses `recordTurnEnd`/`publishTurnEnd`                            | Already tracked in `tasks/backlog/2026-08-17-migrate-cancel-stalled-prompt-to-record-turn-end.md` |
| Snapshot for `da90b7c4` was `degraded` (`entries-skipped`)                                 | Not gated on — matches resumer; noted in tests                                                    |

## Implementation checklist

- [x] 1. `apps/api/src/services/task-runtime-liveness.ts`: add
     `SessionResumabilitySnapshot`, `resumabilityProbeOutcome` +
     `sessionResumability` to `TaskRuntimeLivenessSignals`, and an
     `isSessionResumable()` helper enforcing the four-part predicate above.
- [x] 2. Insert the resumability branch into `classifyTaskRuntimeLiveness` between the
     `INCONCLUSIVE_WORKSPACE_STATUSES` check and the `status !== 'running'` conclusive
     branch. Keep `workspace_missing` conclusive.
- [x] 3. Add `loadSessionResumabilitySnapshot()` next to `loadRuntimeWorkspaceSnapshot()`
     and wire **every** adapter (rule 44 — enumerate all callers of
     `classifyTaskRuntimeLiveness`):
     `apps/api/src/scheduled/stuck-tasks.ts` (`getTaskRuntimeLiveness`) and
     `apps/api/src/durable-objects/project-data/task-runtime-liveness.ts`
     (`getLocalTaskRuntimeLiveness`).
- [x] 4. Regression tests (see below).
- [x] 5. Post-mortem + process fix (rule 02 mandates both).
- [x] 6. File the deferred `loadRecoveryContext` expiry gap as a SAM Idea (`01M076660EE6YENQFDK40S4N9P`).

## Required tests (rule 02 — must be discriminating)

- [x] **Reproduces the incident**: workspace `status='deleted'` + snapshot
      `sleep_status='sleeping'`, `sleeping_at` set, `expires_at` 7 days out
      → `conclusive === false`. Must FAIL on pre-fix code.
- [x] **Degraded snapshot still resumable** (the real `da90b7c4` shape:
      `status='degraded'`, `degradation='entries-skipped'`) → inconclusive.
- [x] **Discriminating control — user delete**: workspace `deleted`, **no** snapshot row
      → still `conclusive: true, reason:'workspace_deleted'`. Proves the fix does not
      blanket-disable terminalization.
- [x] **Bounded escape (rule 47)**: `expires_at` in the past → conclusive dead.
      Plus unparseable/absent expiry → conclusive dead (no immortal tasks).
- [x] **Already woke**: `sleeping_at` set but `sleep_status != 'sleeping'` → conclusive.
- [x] **`workspace_missing` unchanged**: row absent + snapshot present → conclusive
      (matches `loadRecoveryContext`'s workspace-row requirement).
- [x] **Probe failure preserves**: `resumabilityProbeOutcome='error'` on a non-running
      workspace → inconclusive.
- [x] **`not_run` back-compat**: existing signals shape → unchanged verdicts.
- [x] **Both adapters wired**: a vertical-slice test per adapter (rule 35) with realistic
      D1 rows proving the snapshot is actually queried and reaches the classifier.
- [x] **Existing pins updated**: `apps/api/tests/workers/scheduled-stuck-tasks.test.ts:160,198`
      and `apps/api/tests/unit/stuck-tasks.test.ts:1163,1207,1248` assert
      `workspace_deleted` failures — confirm they use no-snapshot fixtures (correct) or
      update them.

## Acceptance criteria

- [x] A slept, unexpired session is never terminalized as conclusive runtime death by any
      of the three paths (stuck-task cron, `processExpiredCleanups`, `checkWorkspaceIdleTimeouts`).
- [x] A user-deleted workspace still terminalizes exactly as before.
- [x] An expired snapshot terminalizes (bounded escape proven by test).
- [x] `pnpm lint && pnpm typecheck && pnpm test && pnpm build` green.
- [ ] Staging deploy green + verified.
- [x] Post-mortem + process fix included in the PR.

## References

- `.claude/rules/02-quality-gates.md` — "sleep… is inconclusive"; regression + process fix
- `.claude/rules/53-scheduled-handler-isolation-and-liveness-signals.md` — liveness ≠ idleness
- `.claude/rules/57-write-only-cross-boundary-state.md` — reconcile, don't just report
- `.claude/rules/47-control-loop-io-budget.md` — bounded escape path
- `.claude/rules/44-dual-write-migration-enumerate-writers.md` — enumerate every adapter
- `tasks/active/2026-08-16-session-activity-state-machine.md` — PR #1840 (ancestor)

## Verification record (2026-08-17, landing run)

Branch rebased onto `origin/main` (`1b89bf598`) — **clean, no conflicts**. PR #1840's
ProjectData DO migration `029-session-activity-reconciliation` was neither renumbered nor
altered.

### Suite result

`apps/api`: 93 passed across `tests/unit/services/task-runtime-liveness.test.ts`,
`tests/unit/stuck-task-slept-session-liveness.test.ts`, and the pre-existing
`tests/unit/stuck-tasks.test.ts` pins (which use no-snapshot fixtures and therefore still
correctly assert `workspace_deleted` terminalization).

### Discrimination proof (rule 58 requires verifying this once)

Neutralizing the resumability branch in `classifyTaskRuntimeLiveness` reproduces the pre-fix
verdicts. Result: **8 failed | 39 passed**. The 8 failures are exactly the incident and
preserve assertions:

- `does not terminalize a slept session with a live snapshot (incident 8bd22a42)`
- `treats a degraded-but-restorable snapshot as resumable (incident da90b7c4)`
- `withholds a death verdict when the resumability probe failed`
- `does not declare a slept, restorable session conclusively dead`
- `preserves a degraded snapshot the recovery path would still restore`
- `applies the same protection to a stopped workspace`
- `preserves a slept, restorable session instead of terminalizing it`
- `withholds a death verdict when the snapshot read fails`

All 39 controls stayed green — user-delete-no-snapshot, expired snapshot, already-woke,
`workspace_missing`, cross-project, cross-workspace, and running-workspace. That proves the
suite is not merely asserting "terminalization is disabled".

### SQL scoping predicates (rule 28 / rule 58)

Deleting `AND project_id = ?` from `loadSessionResumabilitySnapshot` turns
`ignores a snapshot belonging to a different project` red — the predicate is proven
discriminating against a real SQL engine (`better-sqlite3` + `createSqliteD1` +
`createSchemaTables`, not a `.where()`-ignoring mock).

**Nuance worth recording:** deleting `AND workspace_id = ?` does *not* redden the
cross-workspace test, because `isSessionResumable()` also enforces
`snapshot.workspaceId !== workspaceId` in memory. That is intentional defence-in-depth
(rule 28), and `session_snapshots.chat_session_id` is uniquely indexed so only one row can
match the session in the first place. Both layers are exercised; the in-memory guard is what
the cross-workspace assertion discriminates on.

## Specialist review round (2026-08-17)

Three local reviewers ran against the rebased branch. **No CRITICAL or HIGH code findings.**
Everything below was fixed in the branch rather than deferred.

### cloudflare-specialist — ADDRESSED

- **D1 query correctness, index coverage, I/O budget, error handling, DO concurrency: PASS.**
  Independently confirmed `NodeLifecycle.deleteWorkspace` only rewrites `status` and never nulls
  `chat_session_id`, so the probe genuinely engages for the real incident shape.
- **[MEDIUM] The predicate mirrored only half the resumer.** `loadRecoveryContext` assembles
  context, but the function that actually *authorizes* a wake is
  `claimSessionSnapshotRecovery`, whose `WHERE` also requires a restorable
  `status`/`degradation` pair and `recovery_attempts < max`. The original predicate checked
  neither, making the classifier **looser** than the resumer: a snapshot with exhausted wake
  attempts would be preserved for the full 7-day TTL waiting on a wake that can never happen.
  **Fixed** — `isSessionResumable` now mirrors the claim exactly (shared
  `isRestorableSnapshot` helper, plus an env-configurable
  `SESSION_SNAPSHOT_RECOVERY_MAX_ATTEMPTS` ceiling threaded through both adapters). This adds a
  second bounded escape alongside `expires_at`.

### test-engineer — ADDRESSED

- **[MEDIUM] The two "degraded snapshot" tests were non-discriminating duplicates** — they
  seeded `status`/`degradation` that the code never read. **Fixed** by the parity change above:
  those fields are now genuinely read by `isRestorableSnapshot`, and the test asserts the exact
  resumable reason. Verified discriminating.
- **[MEDIUM] `leaves a running workspace on the normal ACP-liveness path` proved nothing** — it
  asserted only `workspaceStatus: 'running'`, which passes even if the resumability branch had
  swallowed the request. **Fixed**: now asserts the reason is neither resumability reason and
  directly asserts `needsSessionResumabilityProbe(...) === false` for a running workspace.
- **[MEDIUM] The cron adapter's own resumability-error path was untested** (only the DO
  adapter's was). **Fixed** — added
  `withholds a death verdict when the cron adapter snapshot read fails`, sharing a
  `brokenSnapshotDb()` helper with the DO test (rule 44 symmetry).
- **[LOW] No in-memory `projectId` re-check** (asymmetric defence-in-depth vs `workspaceId`).
  **Fixed** — `SessionResumabilitySnapshot` now carries `projectId` and `isSessionResumable`
  re-checks it, so both scoping predicates have the SQL + in-memory pair rule 28 asks for.
- **[LOW] Unparseable `expires_at` was only covered at the pure-function boundary.** **Fixed** —
  added a vertical-slice case seeding a literally unparseable value through the real loader.
- **Two-sweep zombie test (rule 47): agreed not required.** `loadSessionResumabilitySnapshot`
  is read-only and mutates no counter, so repeated probing cannot exhaust a destructive budget;
  the bounded escapes (`expires_at`, `recovery_attempts`) are proven directly.

### task-completion-validator — ADDRESSED

- Reproduced the discrimination proof independently (8 red / 39 green) and additionally showed
  that deleting the in-memory `workspaceId` guard reddens the pure-unit case while the SQL
  predicate still covers the vertical slice — confirming both defence layers are real and
  independently load-bearing.
- Confirmed scope boundary respected: no `session-sleep.ts`, no `isActivitySafeForSleep`, no
  `packages/vm-agent/` paths in the diff.
- **[LOW] The "already woke" fixture used `sleep_status='completed'`, a value never written.**
  **Fixed** — the fixture now uses `null`, which is what every real wake path
  (`markSessionSnapshotAwakeInPlace`, `completeSessionSnapshotRecovery`) actually writes, and
  the comment marks the guard as defensive rather than an observed transition.
- **[MEDIUM] Rule 58 referenced `tasks/archive/…` while the file was still in `tasks/active/`.**
  Resolved by archiving the task file in this PR.

### Rule 58 amended

Added a "find the whole resumer before you mirror it" section: the function that reads as the
resumer is often not the one that authorizes the restore, and mirroring only the first leaves
the destroyer *looser* than the resumer — the inverse failure, where unwakeable work is
preserved until its TTL instead of failing promptly.

---

## Post-mortem

### What broke

Task-mode sessions were terminalized as `failed` with
`"Task runtime is conclusively gone after reconciliation grace (workspace_deleted)."`
while their work was intact and restorable. Users saw a red "Task failed" on work that had
merely gone to sleep. **31 tasks** since 2026-08-06, still firing on 2026-08-17.

### Root cause

`classifyTaskRuntimeLiveness` decided recoverability from `workspaces.status` alone, while
`loadRecoveryContext` — the code that actually wakes a slept session — decides from
`session_snapshots.sleeping_at` and never reads `workspaces.status` at all.

`NodeLifecycle` rewrites a slept workspace's `sleeping` status to `deleted` five minutes
after sleep (`node-lifecycle.ts:570-573`, predicate `status IN ('stopped','sleeping')`),
collapsing the one inconclusive marker the classifier understood into a conclusive one.
From that moment the classifier and the resumer disagreed, and the classifier won.

### Timeline

- **2026-08-06** — first occurrence in production `task_status_events`.
- **2026-08-16 20:39–21:36Z** — the two reported kills. Both agents finished their ACP turn
  normally (`end_turn`, 4m28s and 26m11s), slept 17–19 min later, and were failed ~9 min
  after the workspace status flipped. `sleeping_at` + 5 min matches the workspace row's
  `updated_at` in both cases.
- **2026-08-17** — reported and fixed.

### Why it was not caught

- **Every component was individually correct.** The sleep cron is activity-aware and refused
  to sleep a `prompting` session. Both DO idle sweeps route through the shared classifier
  and preserve unless it says dead. The classifier's logic is sound given its inputs. There
  was no single wrong line to find in review.
- **The one shared classifier gave false confidence.** `.claude/rules/02` already required a
  single shared lifecycle classifier, and SAM had one. That guaranteed the cleanup paths
  agreed _with each other_ — and said nothing about whether they agreed with the resumer.
- **Sleep-then-classify was never tested as a sequence.** Tests covered sleep, and covered
  classification, but no test slept a session and then asked the classifier about it. The
  existing `workspace_deleted` assertions all used no-snapshot fixtures, so they encoded the
  buggy verdict as expected behaviour.
- **The symptom read as a different bug.** "Agent was working and got reaped" points at the
  idle detector. The idle detector was innocent; only the D1 audit trail
  (`session_snapshots` rows still `sleeping`/unexpired at kill time) disproved that framing.

### Class of bug

**Destroyer/resumer signal divergence** — two subsystems answering "is this work still
recoverable?" from different records, with a third path (a TTL sweep) mutating only the one
the destroyer reads. Not covered by the existing rules, which addressed _cleanup paths
disagreeing with each other_ rather than _cleanup disagreeing with recovery_.

### Process fix

New rule **`.claude/rules/58-terminal-verdicts-must-match-the-resumer.md`**: any verdict that
work is unrecoverable must be derived from the record the resumer requires, must name that
resumer function in a comment, must be bounded by the artifact's own env-configurable
retention (absent bound → terminal, so nothing becomes immortal), must withhold the verdict
when the lookup fails, and must ship both an incident reproduction _and_ a discriminating
control proving terminalization still fires.

`.claude/rules/02-quality-gates.md:98` amended to state that a shared lifecycle classifier is
necessary but not sufficient, pointing at rule 58.

### What this fix deliberately does NOT change

Sleeping an idle session stays aggressive and unchanged — that behaviour is correct and is
explicit project policy. The fix only stops SAM from mistaking its own sleep for death.
