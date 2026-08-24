# A Successful Session Wake Marks Its Own Predecessor "Failed"

SAM task: `01M0SDQT8TZT4ZHKKPK3CBQ0GW` · Output branch: `sam/root-cause-fix-why-cbq0gw`

## Problem

67% of recent task failures die with
`Task runtime is conclusively gone after reconciliation grace (workspace_deleted).`

The dispatch brief hypothesised that **wakes are failing**, burning the 3-attempt
`recovery_attempts` budget until the rule-58 classifier correctly terminalizes.

**That hypothesis is wrong, and the production data refutes it.** The wakes are
*succeeding*. The failure is an accounting bug: a successful wake hands the chat
session to a brand-new task and leaves its predecessor stranded in `in_progress`
with a deleted workspace — which is byte-for-byte the state the stuck-task sweep
reads as "runtime conclusively gone". The predecessor is then failed, on average
~24 minutes later, while the session it belonged to is alive and working.

The user sees a red "Task failed — runtime conclusively gone" for a conversation
that is running fine.

## Evidence (production D1 `sam-prod`, queried 2026-08-24)

Population: 91 tasks failed with `conclusively gone (workspace_deleted)` since 2026-08-15.

**The stated mechanism does not occur.** `recovery_attempts` never reaches the
`MAX_ATTEMPTS = 3` budget for any killed task — the maximum observed value is `2`,
and 6 of the 11 killed tasks that even have a snapshot row sit at `0`. Nothing is
being terminalized for attempt exhaustion.

**What actually happens** — full trace of `01M0S74Q2G0CM69T7A2G7DGGTE`
(`task_mode=conversation`, `triggered_by=user`):

| time (UTC) | event |
|---|---|
| 06:25:50.672 | predecessor submitted via chat |
| 06:26:49.777 | `delegated → in_progress`, agent session created |
| *(session sleeps — no task event)* | |
| **08:14:40.862** | successor `01M0SDBZXG5AEGZJ0JH2YC30Q4` created: **"Sleeping conversation wake claimed"**, `recovery_source_task_id` = the predecessor |
| 08:14:40.862 | *(same millisecond)* predecessor's workspace `updated_at` bumped — handoff batch strips its chat binding |
| 08:14:47.211 | successor delegated to a **new workspace on the same node** |
| **08:15:30.045** | **predecessor `in_progress → failed`: "conclusively gone (workspace_deleted)"** |
| 08:16:28.224 | successor `in_progress`, agent session live — **still running** |

The wake completed end-to-end. The predecessor was failed 50 seconds *after* its
own successful wake.

**Blast radius:**

| population | count |
|---|---|
| killed with a **direct** successor created at/before the kill | 25 |
| killed **middle-of-chain** links whose successor points past them to the root | 36 |
| **total explained** | **61 / 91 = 67%** |

Supporting counts: 68/91 have `workspaces.chat_session_id IS NULL`; 88/91 have a
workspace row in `status='deleted'`; 42/91 are themselves recovery tasks; one root
task has **8** recovery tasks chained to it. Kill latency after supersession:
min 0 s, mean 1435 s, max 16116 s.

**Ruled out:** the brief's "unmerged vm-agent fix on
`sam/recover-rebase-land-finished-gg6ed6`". That branch — and
`sam/theory-system-sleepwake-vm-frc32q`, `fix/recovery-attempts-lifetime-counter`,
`sam/wake-progress-push-phases` — are **all already landed on `main`** (verified
blob-identical per file); `main` is strictly newer. No unmerged vm-agent work is
relevant. The `recovery_attempts` reset and the rule-58 snapshot escape are both
present and correct, exactly as the brief stated.

## Root cause

`createRecoveryTask` (`apps/api/src/services/session-recovery.ts:163`) commits the
wake handoff as one transactional 5-statement D1 batch:

1. `INSERT` the successor (`status='queued'`, `chat_session_id=NULL`, `recovery_source_task_id=source.id`)
2. `UPDATE tasks SET chat_session_id = NULL WHERE chat_session_id = ? AND (id = ? OR recovery_source_task_id = ?)` — strips the binding from the **previous owner**
3. same `NULL`-ing for the previous owner's `workspaces` row
4. re-bind `chat_session_id` onto the successor
5. `task_status_events` row for the successor

**Nothing in this batch — or anywhere else — transitions the previous owner off
`in_progress`.** Statement 2 identifies exactly the superseded set and then only
un-binds it. The predecessor is left `in_progress`, chat-unbound, workspace
deleted, with no successor pointer of its own.

Three defects compound:

**A — the handoff never terminalizes the task it supersedes.** *(primary)*
A superseded predecessor is indistinguishable from a live task whose runtime died.

**B — the handoff deletes the very column the rule-58 escape is gated on.**
`needsSessionResumabilityProbe` (`apps/api/src/services/task-runtime-liveness.ts:156`)
returns early unless `workspace.chatSessionId !== null`. Statement 3 sets exactly
that column to `NULL`. So the resumability probe **never runs** for a
just-superseded task: `sessionResumability` stays `null`, `isSessionResumable`
returns `false`, and the verdict is `conclusive: true → workspace_deleted`.
This is `.claude/rules/63` verbatim — making a scoping column nullable silently
deleted the check that used it — and `.claude/rules/58`: the destroyer stopped
reading the record the resumer reads.

**C — the sweep is lineage-blind.** `apps/api/src/scheduled/stuck-tasks.ts`
contains **zero** references to `recovery_source_task_id`. It cannot tell
"superseded by a live successor" from "runtime is dead".

**Chain collapse (why 36 kills have no successor pointer).** Source resolution at
`session-recovery.ts:171`:

```ts
const sourceTaskId =
  sourceTaskGuard?.taskId ??
  context.sourceTask?.recoverySourceTaskId ??   // ← collapses to the ROOT
  context.sourceTask?.id ?? null;
```

Every successor points at the **root**, never at its immediate predecessor. So a
middle link is superseded by a sibling that points past it, and even a naive
direct-child lineage check would miss it. Any lineage guard must consider the
whole recovery **family**, not the direct child.

## Fix

**1. Terminalize the superseded owner inside the handoff batch** *(wake/identity side)*

Add a statement to the `createRecoveryTask` batch that transitions the same set
statement 2 already targets to `cancelled` when non-terminal, plus a
`task_status_events` row (`reason: "Superseded by session wake (continued as <id>)"`).
Atomic with the handoff, so no window exists where a superseded task is
`in_progress`. CAS-guarded on `status NOT IN ('completed','failed','cancelled')`
so a concurrent genuine failure is never overwritten (`.claude/rules/02`).

`cancelled` is correct and needs no migration: production `tasks` has **no CHECK
constraint** on `status`, `cancelled` is already in use, `abandonRecoveryHandoff`
(same file, inverse operation) already uses it, and project policy is explicit
that benign lifecycle terminations are cancelled-not-failed and must not trigger
debug diagnosis.

**2. Make the sweep refuse to call a superseded task conclusively gone** *(backstop)*

Before terminalizing, check whether the task's recovery family still has a live
owner. If so → inconclusive/preserve. This is the `.claude/rules/58` fix proper
(destroyer must read what the resumer reads), covers already-stranded rows and any
partial-batch window, and stays off the hot path — it only runs for a task that
would otherwise be declared dead (`.claude/rules/47`). Bounded escape: once the
successor goes terminal the predecessor terminalizes normally.

**Deliberately NOT doing:** widening `loadSessionResumabilitySnapshot` to find the
snapshot by `workspace_id`. After a successful handoff the snapshot is legitimately
re-pointed at the successor's workspace, so the predecessor's workspace genuinely
has no snapshot — only 2 of 91 kills would have been saved that way. The lineage
signal, not the snapshot, is the correct discriminator here.

## Implementation checklist

- [x] ~~Add the supersession-terminalization statement to the `createRecoveryTask` batch~~
      **REJECTED during implementation — it would have made things worse.**
      `sourceTaskGuardCondition` (`session-snapshot-recovery-lifecycle.ts:34`) requires
      the guard's source task to be NON-terminal, and `createRecoveryTask` stmt 1's CAS
      carries `AND (? = 0 OR source.status NOT IN ('completed','failed','cancelled'))`.
      Terminalizing the predecessor would therefore have broken every subsequent guarded
      wake. Keeping it non-terminal is exactly what the guard needs, so the whole fix
      moved to the classifier.
- [x] Add the family-aware live-owner guard (`loadTaskSupersession`,
      `needsTaskSupersessionProbe`, `supersessionVerdict`) to the shared classifier
- [x] Wire it into `stuck-tasks.ts` (cron sweep)
- [x] Mirror it in the ProjectData DO adapter (`.claude/rules/61`: one guard, every runtime)
- [x] Probe only when about to terminalize (`.claude/rules/47` hot-path discipline)
- [x] Fail safe: probe error → inconclusive, never a conclusive death verdict
- [x] Prove the guard discriminating: neutering `supersessionVerdict` turns exactly the
      6 supersession-preservation tests red and leaves all 20 controls green
- [x] No new limits/thresholds introduced, so no `DEFAULT_*` constants required
- [ ] **Deferred** — latent classifier/claim divergence: `isSessionResumable` requires
      `sleepStatus === 'sleeping'` while `claimSessionSnapshotRecovery` only requires
      `sleeping_at IS NOT NULL`, yet the doc comment asserts they are equal. Verified
      **0 production rows** match (`sleeping_at IS NOT NULL AND sleep_status <> 'sleeping'`),
      so it is latent, not a live cause. Out of scope for an urgent fix.

## Measured cost (`.claude/rules/47` / `.claude/rules/60`)

The probe runs only when the sweep is about to terminalize a task AND the snapshot has
not already proved the session resumable (that short-circuits the classifier before
supersession is consulted, so the read is skipped entirely).

It is two `LIMIT 1` existence checks rather than one aggregate, deliberately. `live` is
the hot case — a preserved predecessor is re-probed every sweep tick for as long as its
successor runs — so it early-exits at the first match. `terminal`/`none` costs the second
read but is reached once, after which the task leaves the candidate set.

`EXPLAIN QUERY PLAN` against production:

```
SEARCH self  USING INDEX sqlite_autoindex_tasks_1 (id=?)                  -- PK point lookup
SEARCH owner USING INDEX idx_tasks_project_created_at (project_id=? AND created_at>?)
```

Worst-case scan width is tasks created in that project after the candidate. The busiest
production project peaks at **41 tasks/day** (4131 all-time) and sweep candidates are
hours old, so the range is tens of indexed rows. A review benchmark put the worst
realistic case at ~478 µs and the common case at ~8 µs at today's scale.

Note the planner does NOT use `idx_tasks_recovery_source_task_id` for the OR-across-two-
columns join, in this or any variant tried (scalar subquery, UNION ALL). Forcing it needs
`INDEXED BY`, which was rejected as brittle. Revisit if a single project ever reaches
tens of thousands of tasks.

## Conscious scope decisions (review findings decided, not silently inherited)

- **`trigger_executions` stays two-valued.** `syncTriggerExecutionStatus` collapses any
  non-`completed` status to `failed` for the linked trigger execution, so a superseded
  predecessor's trigger row still reads `failed`. Left as-is deliberately: the column has
  no CHECK constraint but has only ever held `completed`/`failed` (317/87 in production),
  its consumers (`skipIfRunning`) treat every non-completed value identically, and adding
  a third persisted enum value is a schema-semantics change (rule 31) well outside an
  urgent reliability fix. No functional regression — a `failed` execution unblocks future
  firings exactly as before.
- **`deadRuntimeReconciled` still counts benign supersessions.** The metric name implies
  runtime death; splitting it would change an existing dashboard/alerting signal. Noted
  in the follow-up idea rather than changed mid-incident-fix.
- **`INDEXED BY` rejected** for forcing `idx_tasks_recovery_source_task_id` — brittle if
  the index is ever renamed or dropped. See the measured-cost section.

## Closing the delayed-failure gap (added after review)

The first cut preserved the predecessor only *while* its successor lived, so once the
conversation ended the predecessor still resolved to `failed`. Four independent
reviewers flagged that as merge-blocking: it delays the false failure rather than
eliminating it, and it means every completed recovery chain eventually emits a
retroactive red failure on a conversation that finished normally.

Fixed by making supersession a three-state signal (`none` / `live` / `terminal`):

- `live` -> inconclusive, preserve (guarded wakes keep working)
- `terminal` -> conclusive (bounded escape, rule 47) but with a distinct reason suffix
  `_superseded_by_completed_wake`, which the sweep's terminal writer keys on to record
  **`cancelled`** with a benign message instead of `failed`.

This is safe with respect to the wake path, which is why terminalizing was rejected at
handoff time but is correct here: a superseded predecessor always has a NULL
`chat_session_id` (handoff stmt 2), and `terminal` means no live recovery owner exists,
so BOTH branches of `sourceTaskGuardCondition`'s OR are already false — the guarded wake
was failing for this task regardless of its status. Terminalizing at *handoff* time
would have broken it; terminalizing *after the family ends* cannot.

`cancelled` also routes correctly through `syncTriggerExecutionStatus` and
`cancelVmTaskAdmission`, and project policy is explicit that benign lifecycle
terminations must be distinguishable from failures and must not trigger debug diagnosis.

## Required tests

Per `.claude/rules/62` (reach the feature the way production does) and `.claude/rules/58`:

- [x] **Incident reproduction through the REAL writer**: `session-recovery-handoff.test.ts`
      drives the actual `ensureSessionRecovery` -> `createRecoveryTask` batch, then runs
      the real classifier against the predecessor it left behind (rule 62).
- [x] **Discriminating control**: a never-superseded task still terminalizes as
      `failed`/`workspace_deleted`, paired with the benign-cancellation case.
- [x] **Chain-collapse case**: middle link AND root of a 3-generation chain both
      preserved; a direct-child-only check is proven insufficient.
- [x] **CAS guard**: the sweep's terminal write keeps its existing
      `WHERE id = ? AND status = ?` optimistic lock, so a concurrent real failure is
      never overwritten. (No new write at handoff time — see the rejected item above.)
- [x] **Capability preserved**: a guarded `claimSessionSnapshotRecovery` still resolves
      after the sweep classifies the predecessor — proving the parent-wake path the
      false failures were revoking actually survives, not just that the label is nicer.
- [x] **Bounded escape** (`.claude/rules/47`): once the successor terminalizes the
      predecessor leaves the candidate set — as a benign `cancelled`, not `failed`.
- [x] Real SQL engine (`createSqliteD1` + `createSchemaTables`) throughout (`.claude/rules/28`).
- [x] **Proven discriminating**: neutering `supersessionVerdict` turns exactly the 11
      supersession tests red and leaves all 29 controls green. Verified, then restored.

## Acceptance criteria

- [x] A successful wake leaves its predecessor in a benign terminal state, never `failed`
      (preserved while the successor lives; `cancelled` once the family ends)
- [x] The classifier cannot declare a task conclusively gone while its recovery family
      has a live owner
- [x] Both terminalization paths (cron sweep + ProjectData DO) agree
- [ ] Staging: sleep a session, wake it, confirm the predecessor is not failed and the
      successor runs
- [ ] Production after deploy: `conclusively gone` kills with a live/newer family owner
      drop to ~0 (baseline: 61/91 over the prior 9 days)

## Post-mortem

- **What broke**: successful session wakes recorded their predecessor as a hard failure.
- **Root cause**: the wake handoff transferred ownership without terminalizing the task
  it superseded, and simultaneously nulled the column the safety escape was gated on.
- **Why it wasn't caught**: every component was individually correct and every test
  green. The handoff was tested for what it *creates*, never for what it *leaves behind*.
  Rule 58 was applied to the snapshot record but not to task lineage.
- **Class of bug**: an ownership transfer that terminalizes nothing — the predecessor
  becomes indistinguishable from a corpse. Sibling of `.claude/rules/63`
  (a nullable scoping column deleting the check that used it) and `.claude/rules/58`
  (destroyer and resumer reading different records).
- **Process fix**: propose a rule — *an ownership handoff must terminalize the owner it
  replaces, in the same transaction* — with the corollary that any predicate nulled by a
  handoff must be enumerated against every consumer that reads it (`.claude/rules/44`).

## References

- `.claude/rules/58-terminal-verdicts-must-match-the-resumer.md`
- `.claude/rules/63-widening-a-table-can-delete-an-auth-check.md`
- `.claude/rules/47-control-loop-io-budget.md`
- `.claude/rules/62-tests-must-observe-the-real-trigger.md`
- `.claude/rules/28-credential-resolution-fallback-tests.md`
- Idea `01M0SD6W5SR7FWFVWTK7DWV318` (recovery-task ULID / lineage-check bug)
