# A "Work Is Unrecoverable" Verdict Must Read The Same Record The Resumer Reads

## When This Applies

Any code that writes a **terminal verdict about recoverability** — "this runtime is
conclusively gone", "this session is dead", "this job cannot be retried", "this workspace
is unreachable" — while a **separate code path elsewhere can still restore that work**
from a snapshot, checkpoint, replica, backup, or queued replay.

The canonical pair in this repo:

| Role      | Function                                                                         | Signal it reads                 |
| --------- | -------------------------------------------------------------------------------- | ------------------------------- |
| Destroyer | `classifyTaskRuntimeLiveness` (`apps/api/src/services/task-runtime-liveness.ts`) | `workspaces.status`             |
| Resumer   | `loadRecoveryContext` (`apps/api/src/services/session-recovery.ts`)              | `session_snapshots.sleeping_at` |

**Find the whole resumer before you mirror it.** The restore path is usually more than one
function, and the one that reads most naturally as "the resumer" is often not the one that
actually authorizes the restore. Here `loadRecoveryContext` merely assembles context; the real
gate is `claimSessionSnapshotRecovery`
(`apps/api/src/services/session-snapshot-recovery-lifecycle.ts`), whose `WHERE` clause adds a
restorable `status`/`degradation` pair and `recovery_attempts < max`. Mirroring only the
first function leaves the destroyer _looser_ than the resumer — the opposite failure to the
original bug, and just as real: work the resumer will never wake is preserved anyway, so the
task hangs until the artifact's TTV expires instead of failing promptly. Enumerate every
predicate on the path from "candidate" to "restored" and mirror the union.

## Why This Rule Exists

On 2026-08-16, 31+ production tasks (`2026-08-06` onward, still firing on `2026-08-17`)
were terminalized as
`"Task runtime is conclusively gone after reconciliation grace (workspace_deleted)."`
while their sessions were asleep, unexpired, and fully restorable for another seven days.

The chain was entirely composed of individually-correct steps:

1. An agent's ACP turn ended normally (`end_turn`). The task stayed `in_progress` /
   `awaiting_followup`.
2. The session-sleep cron slept it after the idle interval — **correct**, and exactly what
   the "aggressively sleep idle sessions" policy asks for. A snapshot was captured;
   `workspaces.status` became `sleeping`; `session_snapshots.sleep_status='sleeping'` with
   an `expires_at` seven days out.
3. Five minutes later `NodeLifecycle` ran
   `UPDATE workspaces SET status='deleted' ... WHERE status IN ('stopped','sleeping')`
   (`apps/api/src/durable-objects/node-lifecycle.ts`) — **rewriting the inconclusive `sleeping` marker into the
   conclusive `deleted` marker.**
4. The classifier read `workspaces.status`, saw `deleted`, and returned
   `conclusive: true`. The stuck-task sweep wrote `failed`.

Every step was locally defensible. The system was still wrong, because **the destroying
side and the restoring side were reading different records.** `loadRecoveryContext` never
reads `workspaces.status` at all — a `deleted` workspace row was, and remains, perfectly
wakeable. Nothing forced the two to agree, and nothing tested them as a pair.

Note that a shared classifier already existed, as `.claude/rules/02` requires. A single
shared classifier is necessary but **not sufficient**: it prevented the _cleanup paths_
from disagreeing with each other, while leaving the classifier free to disagree with the
resumer.

## Class of Bug

**Destroyer/resumer signal divergence.** Two subsystems answer the same question — "is this
work still recoverable?" — from different columns, and a third path (here, a TTL sweep)
mutates the column only one of them reads. The failure is invisible in isolation: the
classifier's logic is correct given its inputs, the resumer's logic is correct given its
inputs, and the TTL sweep is doing its documented job.

Tells:

- A terminal verdict derived from a **status/lifecycle enum** rather than from the artifact
  that actually enables recovery.
- A TTL, GC, or retention sweep whose predicate spans an inconclusive state
  (`WHERE status IN ('stopped','sleeping')`) and collapses it into a terminal one.
- A recovery path whose precondition set is _narrower_ than the destroy path's — i.e. it can
  restore things the destroyer already declared dead.

## Hard Requirements

1. **Derive the terminal verdict from the recovery precondition, not from a status enum.**
   Before writing "unrecoverable", read the same record the resumer requires. If the resumer
   would accept it, the verdict must be **inconclusive**.

2. **Mirror the resumer's predicate explicitly, and say so in a comment naming the
   function.** When the destroyer's predicate is deliberately _stricter_ than the resumer's,
   the extra condition must be justified in that comment (in the canonical fix the only
   addition is an expiry bound; see requirement 3).

3. **Every "preserve" verdict needs a bounded escape** (`.claude/rules/47`). Preserving
   recoverable work must not create an immortal task. Bound it on the artifact's own
   retention (`expires_at`), and treat an **absent or unparseable** bound as _not_
   recoverable so a malformed row cannot pin work open forever. The bound must be
   env-configurable with a `DEFAULT_*` constant.

4. **A failed recoverability lookup withholds the terminal verdict.** The destructive action
   is the irreversible one, so an unknown answer must not resolve to "destroy".

5. **Do not add a `*_reason` / `*_cause` column just to tell the causes apart** when an
   existing artifact already discriminates. In the canonical fix, snapshot _presence_ is the
   discriminator: a user-initiated delete destroys the snapshot row
   (`session-snapshot-persistence.ts:deleteSessionSnapshotState`), an idle sleep keeps it.
   Prefer the record that already exists over new schema.

6. **Keep the lookup off the hot path** (`.claude/rules/47`). Probe only for candidates that
   would otherwise be terminalized, so a control loop pays the extra read only when it is
   about to take the destructive action.

7. **Lifecycle finalizers that stop/archive a user-visible session are destroyers too.**
   A shared teardown helper can still be wrong if it centralizes the destructive mutation
   at the wrong altitude. Before a finalizer calls `stopSession`, archives a conversation, or
   otherwise removes a wake path for a non-failed runtime teardown, it must read the same recovery
   artifact the wake path reads. For sleeping conversations that means `session_snapshots`, not the
   old workspace/node row being torn down. Failed/error closures are exempt only when they are
   intentionally recording a failed runtime outcome with `failSession`, rather than archiving a
   recoverable sleep. Exercise the real writer that reaches the finalizer (NodeLifecycle, cron
   cleanup, explicit delete, task-terminal cleanup, etc.), because a direct helper test cannot
   prove production reaches the guard.

## Required Tests

- **The incident, reproduced**: the artifact is recoverable, the status enum says dead →
  assert **inconclusive**. Must FAIL against the pre-fix code; verify that once.
- **The discriminating control**: same status enum, artifact genuinely absent → assert the
  terminal verdict still fires. Without this, a test suite passes equally well if
  terminalization were disabled outright.
- **The bound**: expired artifact → terminal. Absent/unparseable bound → terminal.
- **Scoping predicates against a real SQL engine** (`.claude/rules/28`): cross-tenant and
  cross-resource fixtures, each proven discriminating by deleting the predicate.
- **Every adapter** that feeds the classifier supplies the new signal
  (`.claude/rules/44` — enumerate them; a signal wired into one adapter and not another
  reintroduces the bug on the unwired path).
- **Every lifecycle finalizer caller that can stop/archive a session is enumerated** and the
  main teardown writers are covered through their real production entry points, not only by
  calling the shared finalizer directly.

## Quick Compliance Check

- [ ] The terminal verdict reads the resumer's own record, not just a status enum
- [ ] A comment names the resumer function the predicate mirrors
- [ ] Any extra strictness vs. the resumer is justified in that comment
- [ ] Preserve verdicts are bounded by an env-configurable retention; absent bound → terminal
- [ ] A failed recoverability lookup withholds the terminal verdict
- [ ] The probe fires only for otherwise-doomed candidates
- [ ] Incident reproduction + discriminating control both exist, and the reproduction was
      verified to fail pre-fix
- [ ] Session stop/archive finalizers are treated as terminal verdict writers and covered
      through at least the primary real teardown entry points

## References

- Task: `tasks/archive/2026-08-17-fix-slept-session-classified-as-dead.md`
- `.claude/rules/02-quality-gates.md` — "sleep, wake, restore, replacement, probe failure,
  and unknown state are inconclusive"; one shared lifecycle classifier
- `.claude/rules/47-control-loop-io-budget.md` — bounded escape paths, I/O budget
- `.claude/rules/53-scheduled-handler-isolation-and-liveness-signals.md` — a signal that
  cannot answer the question being asked of it
- `.claude/rules/57-write-only-cross-boundary-state.md` — reconcile, don't just report
- `.claude/rules/44-dual-write-migration-enumerate-writers.md` — enumerate every adapter
- `.claude/rules/28-credential-resolution-fallback-tests.md` — SQL predicates need a real
  SQL engine
