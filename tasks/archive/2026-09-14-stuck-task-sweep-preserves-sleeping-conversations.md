# Stop the stuck-task sweep from terminalizing sleeping conversations as failed tasks

**SAM task**: `01M2FT64SRZ4KVCHSNJXQACYG8`
**Idea**: `01M2CKHT52MKAZ8DTH91N6J185`
**Related ideas**: `01M0SHQDH3FQQG7NMFKMFPSXWM` (age the live runtime generation),
`01KZM7R67CN19RA29MV6EE0DAA` (runtime loss while waiting for the user),
`01M13WC07W88NKBGB262X7PCK4` (reconciliation/liveness authority)

## Problem

The stuck-task sweep (`apps/api/src/scheduled/stuck-tasks.ts`) terminalizes conversations that
have already gone to sleep correctly and are still wakeable. Every one shows the user a red
"Task failed" banner, and conversation-mode reads as a ~96% failure rate in production.

Measured against `sam-prod` D1 on 2026-09-14 (7-day window, 113 failed tasks, 57 of them
sweep verdicts of the three classes in scope):

| Sub-case | n | Why it fails today |
|---|---|---|
| Ceiling branch, `sleep_status='sleeping'` | **45** | Ceiling short-circuits before any liveness/resumability probe |
| Classifier `workspace_missing`, sleeping | **4** | `task.workspace_id IS NULL`; conclusive return has only a supersession escape |
| `sleep_status='scheduled'` (sleep in flight) | **1** | `isSessionResumable` requires `'sleeping'` |
| Wake budget spent inside the decay window | **3** | Rule-58-consistent with the resumer — **out of scope** |
| Genuinely dead (`terminal_failed` / no snapshot) | **16** | Correct. **Must keep failing.** |

Daily series since 08-30: 10, 6, 1, 4, 11, 8, 5, 4, 4, 1, 7, 5, 4, 10 — it fires every day.

## Research findings

### F1. The liveness branch was already right; the ceiling overrode it

For **all 45** ceiling failures with a sleeping snapshot:

- `tasks.workspace_id` is set, and the workspace row exists with `status='deleted'`
- `workspaces.chat_session_id` is set
- `session_snapshots.workspace_id` **matches** `tasks.workspace_id`
- the snapshot was **unexpired** at failure time (45/45)
- the wake budget was **unspent** (`recovery_attempts = 0`, 45/45)

So `needsSessionResumabilityProbe` → `loadSessionResumabilitySnapshot` → `isSessionResumable`
already returned `true` for these rows, and the liveness branch preserved them as
`workspace_deleted_snapshot_resumable` for ~20 hours (from the 4h soft timeout to the 24h
ceiling). The ceiling then killed them because `executionMs > absoluteCeilingMs` is checked
**inside** `if (executionMs > maxExecutionMs)` and `break`s before `probeLiveness()` runs
(`stuck-tasks.ts:1122-1181`).

Timestamps confirm the sessions slept early and sat asleep for the rest of the window — e.g.
task `01M2CSDFKHJJ13HTCAR1N5EJSX`: `started_at` 07:11:50, `sleeping_at` 07:56:05,
failed 24h later at 07:16:06 the next day.

→ **Checklist C2, C3.**

### F2. `workspace_missing` has no resumability escape

`classifyTaskRuntimeLiveness` (`services/task-runtime-liveness.ts:367-377`):

```ts
if (!signals.taskWorkspaceId || !workspace) {
  return supersessionVerdict(signals, workspace, 'workspace_missing') ??
    result(workspace, { live: false, conclusive: true, reason: 'workspace_missing', ... });
}
```

The 4 production cases have `tasks.workspace_id IS NULL` **and**
`session_snapshots.workspace_id IS NULL`, with the snapshot reachable only by
`(chat_session_id, project_id)` — both of which match. The existing resumability loader
cannot reach them: `loadSessionResumabilitySnapshot` requires `workspace.id`, and
`needsSessionResumabilityProbe` additionally requires `workspace.chatSessionId !== null`.

→ **Checklist C1, C4.**

### F3. There are THREE terminalization consumers of the same verdict (rule 61)

| Consumer | Entry point |
|---|---|
| Cron sweep | `scheduled/stuck-tasks.ts` → `transitionTaskToTerminal` |
| ProjectData idle cleanup | `durable-objects/project-data/idle-cleanup-terminalization.ts:200` |
| ProjectData reconciliation | `durable-objects/project-data/reconciliation.ts:157` → `handleTerminalDelivery` → `terminallyFailDeadTarget` |

All three key on `liveness.conclusive && !liveness.live`. Fixing only the cron sweep would
leave two runtimes able to destroy the same sleeping session. The fix therefore belongs in the
**shared classifier**, with the cron ceiling (which bypasses the classifier entirely) patched
separately.

→ **Checklist C1 (classifier, shared), C2/C3 (ceiling, sweep-only).**

### F4. The resumer's own predicate already exists and already covers `scheduled`

`findRestorableOrInFlightSleepSnapshot` / `restorableOrInFlightSleepSnapshotPredicateSql`
(`services/session-snapshot-sleep-predicate.ts`):

- keyed on `(chat_session_id, project_id)` with an **optional** `workspace_id` clause
- accepts fully restorable `sleeping` snapshots **and** in-flight
  `scheduled` / `preparing` / `stopping` / `failed`
- shares the recovery-budget decay predicate (`sessionRecoveryBudgetAvailableSql`), so it
  cannot become a second budget policy
- **bounded on both arms**: `sleeping` requires `expires_at > now`; in-flight requires the
  claim/update stamp be newer than `now - SESSION_SLEEP_IN_FLIGHT_MAX_AGE_MS`
  (30 min default, 24 h cap)

It already has four production consumers (`workspace-lifecycle-finalizer`,
`terminal-node-lifecycle-repair`, `session-summary-ledger-reconciliation`,
`project-data/terminal-session-reconciliation`). Adding the terminalization paths as further
consumers is the rule-58 pairing ("the destroyer reads what the resumer reads") and needs no
new policy.

→ **Checklist C1, C2.**

### F5. The ceiling measures conversation age, not compute

Idea `01M0SHQDH3FQQG7NMFKMFPSXWM` acceptance criterion: "Cost ceiling measures the lifetime of
an allocated/live runtime generation, not the age of a long-lived conversation row."
**45/45** ceiling failures had `workspaces.status='deleted'` — no compute existed to bound.

A wake creates a *new* task (`triggered_by='session-recovery'`) with a fresh `started_at` and a
fresh workspace, so `workspaces.created_at` sits a few minutes *before* `started_at` for this
population — aging from the workspace alone changes almost nothing. The load-bearing half of
the criterion is the other one: **the ceiling must only apply while a runtime generation is
actually allocated.**

→ **Checklist C3.**

### F6. The red banner is driven by `tasks.error_message`

`FloatingHeader.tsx:52-95` renders the failure block iff `taskEmbed.errorMessage` is non-null,
and `classifyFailure` (`packages/shared/src/failure-classification.ts`) carries a
`diagnosable: boolean` explicitly documented as "False for expected lifecycle outcomes that are
not themselves bugs".

`terminalErrorMessage()` in `services/task-terminal-transition.ts:76` returns `null` only for
`status === 'completed'`, so the benign supersession **cancellation** still writes
`error_message` and still shows a red banner. Worse, `SUPERSEDED_TERMINATION_MESSAGE`
("Superseded by a later session wake…") matches no `classifyFailure` rule, so it falls through
to `unknown` → label "Failed", `diagnosable: true`. That violates policies `a974b04f`
("Do not diagnose normal lifecycle terminations") and `486d1dd1` ("Parent-stopped tasks are
cancelled, not failed").

`task_status_events.reason` is written from `options.reason` independently of `error_message`,
so the reason and timeline survive suppression.

→ **Checklist C5, C6.**

### F7. File size

`stuck-tasks.ts` is **1567 lines** with a documented `FILE SIZE EXCEPTION` saying "split in a
focused follow-up". Per rule 18 no new logic may be grown into it. All new logic goes in a new
module; the sweep delta is call sites only.

→ **Checklist C2.**

### F8. Test fidelity

`stuck-tasks.test.ts` uses a SQL-substring-keyed mock whose `.where()` ignores arguments —
banned by rule 28 for guards that *are* SQL predicates. New tests must use
`createSqliteD1` + `createSchemaTables` (`apps/api/tests/helpers/sqlite-d1.ts`) and enter
through `recoverStuckTasks`, not the branch handlers.

The existing `stuck-task-slept-session-liveness.test.ts` enters through `getTaskRuntimeLiveness`
(the adapter), which is exactly why it never observed the ceiling bug — the ceiling never calls
that adapter. Rule 62.

The pinned assertion to preserve is
`expect(projectDataMocks.getTaskAcpLivenessSignals).not.toHaveBeenCalled()`
(`stuck-tasks.test.ts:1103`) — no ProjectData DO round-trip on the ceiling path. Cheap D1
reads are allowed.

→ **Checklist C7-C11.**

## Decision: representation of a sleeping conversation (required by the idea)

The idea asks for one of: (a) a distinct `sleeping` execution step the sweep skips, or
(b) excluding `task_mode='conversation' AND execution_step='awaiting_followup'` from the
candidate query.

**Chosen: neither. Read the authoritative record at verdict time.**

- **(a) is a new proxy signal, and a dangerous one.** `execution_step='sleeping'` would be a
  cached copy of `session_snapshots.sleep_status` that can diverge: sleep fails after the step
  is written, or a wake succeeds and nothing clears it. A task parked at
  `execution_step='sleeping'` whose snapshot is actually gone becomes **permanently invisible to
  the cost backstop** — strictly worse than the bug being fixed, and exactly the
  correlated-proxy failure `.claude/rules/74` exists to prevent. It also adds a writer to an
  ordered, UI-bearing enum (`EXECUTION_STEP_ORDER`, `EXECUTION_STEP_LABELS`, wake labels) with a
  dual-write hazard across the sleep lifecycle (`.claude/rules/44`).
- **(b) misses 10 of the 45** ceiling cases, which failed at `Last step: running`, not
  `awaiting_followup`; and it would blind the sweep to genuinely dead conversation runtimes at
  `awaiting_followup` — 6 of the 16 correct failures in the window — leaving real orphaned
  compute unreaped. That breaks "keep the cost backstop working".

The sleeping conversation does **not** in fact sit in `in_progress` forever: the preserve is
bounded by construction (F4). `sleeping` needs `expires_at > now`, so once the snapshot TTL
lapses the ordinary liveness branch terminalizes it with the correct reason; the in-flight arm
is bounded to `SESSION_SLEEP_IN_FLIGHT_MAX_AGE_MS`. There is no immortal row and no new state to
keep in sync.

## Implementation checklist

- [x] **C1** Add a task-scoped sleep signal to the shared classifier.
  `TaskRuntimeLivenessSignals.taskSessionSleep: 'not_run' | 'none' | 'preserve' | 'unknown'`.
  `classifyTaskRuntimeLiveness` consults it immediately before the conclusive return in **both**
  the `!taskWorkspaceId || !workspace` branch (→ `workspace_missing_session_sleeping` /
  `_session_sleep_unknown`) and the `workspace.status !== 'running'` branch (after the more
  specific `_snapshot_resumable` check so that reason still wins). Inconclusive, never live.
- [x] **C2** New module `apps/api/src/services/task-sleep-preservation.ts` exposing
  `loadTaskSleepPreservation(db, env, { projectId, chatSessionId })` →
  `'none' | 'preserve' | 'unknown'`, delegating to `findRestorableOrInFlightSleepSnapshot`
  **without** a workspace filter. No `chatSessionId` ⇒ `'none'` with no query. Read failure ⇒
  `'unknown'` ⇒ preserve (the established withheld-verdict convention), bounded by the next tick.
  Populate `taskSessionSleep` from it in **all three** adapters (rule 61): cron
  `getTaskRuntimeLiveness`, ProjectData `getLocalTaskRuntimeLiveness`, and the cron ceiling.
- [x] **C3** Ceiling branch: age from the **allocated live runtime generation** and apply the
  ceiling only while one exists. Add `createdAt` + reuse `status` from
  `loadRuntimeWorkspaceSnapshot` (one extra column, no extra round-trip). No workspace row, or a
  terminal workspace status ⇒ no compute to bound ⇒ do not terminalize on cost grounds; the
  liveness branch owns those at 4h/8h. Workspace read failure ⇒ fall back to `tasks.started_at`
  and apply the ceiling (fail closed — a degraded read must not weaken the backstop).
- [x] **C4** Give `getTaskRuntimeLiveness` the task's `chat_session_id` (already present on
  `StuckTaskCandidate`; add it to the `getTaskReconciliationDiagnostics` projection too) so the
  sleep signal is keyed on the canonical chat session, not on the workspace row.
- [x] **C5** `transitionTaskToTerminal`: add `lifecycleOutcome?: boolean`. When set, suppress
  `tasks.error_message` while still writing `task_status_events.reason`. Use it for the
  superseded cancellation in the cron sweep and in `idle-cleanup-terminalization.ts`.
- [x] **C6** Add a `classifyFailure` rule so the superseded-wake wording classifies as
  `cancelled` (`diagnosable: false`) for rows already carrying it.
- [x] **C7** Tests: real-D1 sweep tests via `createSqliteD1` + `createSchemaTables`, entering
  through `recoverStuckTasks`. Ceiling: sleeping snapshot + deleted workspace + `started_at` 25 h
  ago ⇒ preserved, status unchanged, `stuck_task.preserved_sleeping` logged. Verify RED pre-fix.
- [x] **C8** Same for the 240/480-minute liveness path and the reconciliation-grace path,
  including the `workspace_id IS NULL` + snapshot-`workspace_id`-NULL shape and the
  `sleep_status='scheduled'` shape.
- [x] **C9** Control: live VM runtime, 25 h old, fresh heartbeat, no snapshot ⇒ still
  terminalized by the ceiling with the runaway-cost reason.
- [x] **C10** Control: genuinely dead runtime (no snapshot, workspace missing) ⇒ still
  terminalized by the liveness path. Control: snapshot expired ⇒ still terminalized.
- [x] **C11** Prove every new guard discriminating by deleting it once; record which test
  reddened for which guard in the PR.
- [x] **C12** Docs sync: public behaviour docs for task lifecycle/sleep if any describe the
  ceiling. Grep before assuming none.
- [x] **C13** Staging deploy + live verification. Delete any staging node/workspace created.
- [x] **C14** Production verification query returns 0 for rows failed after the deploy.
- [x] **C15** Update idea `01M2CKHT52MKAZ8DTH91N6J185` with the outcome.

## Acceptance criteria

- [ ] A sleeping, restorable conversation older than 24 h is **preserved** by the ceiling branch,
      not failed, with no status change and no `error_message`. (C2, C3, C7)
- [ ] A conversation whose `tasks.workspace_id` is NULL but whose chat session has a restorable
      snapshot is preserved by the classifier on all three terminalization runtimes. (C1, C8)
- [ ] A conversation mid-sleep (`sleep_status='scheduled'`) is preserved. (C2, C8)
- [ ] A demonstrably live runtime past the ceiling is **still** terminalized and cleaned up. (C9)
- [ ] A genuinely gone runtime with no restorable snapshot is **still** terminalized. (C10)
- [ ] An expired snapshot no longer preserves — the task leaves `in_progress`. (C10)
- [ ] Benign lifecycle verdicts write no `tasks.error_message` and classify as non-diagnosable,
      while `task_status_events.reason` still records why. (C5, C6)
- [ ] The representation decision is documented and justified in the PR. (this file)
- [ ] Production query returns 0 new occurrences after the deploy. (C14)

## References

- `.claude/rules/74-proxy-signals-must-match-the-condition.md` — the gate must key on its condition
- `.claude/rules/58-terminal-verdicts-must-match-the-resumer.md` (scoped: `apps/api/`)
- `.claude/rules/62-tests-must-observe-the-real-trigger.md` — enter through the real sweep
- `.claude/rules/61-guards-must-cover-every-runtime.md` (scoped: `apps/api/`)
- `.claude/rules/47-control-loop-io-budget.md` (scoped: `apps/api/`)
- `.claude/rules/28-credential-resolution-fallback-tests.md` — no `.where()`-ignoring mocks
- `.claude/rules/18-file-size-limits.md`
- Policies `a974b04f`, `486d1dd1`, `0f05422d` (canonical session idleness), `d08d64dc`


## Outcome (2026-09-14)

Implemented on `sam/stop-stuck-task-sweep-qacyg8`. C1-C13 complete; C14 (production query) and C15
(update idea `01M2CKHT52MKAZ8DTH91N6J185`) follow the production deploy.

**Scope grew during implementation, for a good reason.** Proving the guards discriminating
(`.claude/rules/62` req 4) revealed that the classifier has FIVE conclusive-death returns and the
first cut guarded two. `node_not_live`, `cf_container_<terminal>` and `task_acp_session_terminal`
are all reachable while `workspaces.status` still reads `running` — the window between NodeLifecycle
destroying the node for sleep and the workspace row catching up. Production carried that shape
(`node_not_live` + `scheduled` snapshot, twice in 30 days). All five now route through one
`conclusiveDeath()` constructor.

**Two things deliberately NOT done, with reasons:**

1. A deferred supersession probe, suggested in review. Implemented, then reverted as dead code: a
   superseded predecessor has NULL `workspaces.chat_session_id` and exits earlier and inconclusively
   at `workspace_runtime_identity_incomplete`, so it can never reach those three sites. Documented in
   `conclusiveDeath()` so nobody retries it.
2. Adding `archiveMigrationFenceCondition` to the shared sleep predicate. It belongs there — the
   guard is currently looser than the resumer for archived sessions — but moving it affects five
   consumers at once and must be done for all of them together. Documented in
   `task-sleep-preservation.ts` per rule 58 req 2; tracked in idea `01M2FYF0AJC1AHFBKHW19A8BGM`.

**Follow-ups:** idea `01M2FYF0AJC1AHFBKHW19A8BGM` (archive fence, duplicate point lookup,
`reconciliation-dead-target.ts` still labelling a superseded-terminal reason as `failed`).
