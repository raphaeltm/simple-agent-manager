# Stop the stuck-task sweep from marking sleeping conversations as failed

- **SAM task**: `01M2CNT3CYPCTW1G7G48AZQBPH`
- **SAM idea**: `01M2CKHT52MKAZ8DTH91N6J185` (primary), `01M0SHQDH3FQQG7NMFKMFPSXWM` (ceiling half)
- **Branch**: `sam/stop-stuck-task-sweep-azqbph`
- **Rules**: `.claude/rules/58` (terminal verdicts must read what the resumer reads),
  `.claude/rules/74` (a gate must key on its condition), `.claude/rules/47` (bounded escape),
  `.claude/rules/62` (tests observe the real trigger), `.claude/rules/66` (one choke point),
  `.claude/rules/28` (SQL predicates need a real SQL engine)
- **Policies**: `a974b04f` (do not diagnose normal lifecycle terminations),
  `486d1dd1` (parent-stopped tasks are cancelled, not failed)

## Problem

`apps/api/src/scheduled/stuck-tasks.ts` terminalizes sleeping conversations as `failed`.
Every one shows a red "Task failed" on a conversation that is intact and wakeable.

Production `sam-prod` D1, window 2026-09-06 → 2026-09-13, **re-verified 2026-09-13** by this task:

| Branch                                   | failures | with `sleep_status='sleeping'` |
| ---------------------------------------- | -------: | -----------------------------: |
| Ceiling (`:1116-1181`)                   |       35 |                             32 |
| Liveness (`:1183-1230`)                  |       12 |                              5 |
| Reconciliation grace (`:1258-1275`)      |        7 |                              4 |
| Other (genuine agent/provider failures)  |       40 |                              0 |
| **Total failed tasks in window**         |   **94** |                         **41** |

Verification SQL (the idea's query) returns **41** today. 79 of the 80 ceiling firings in the
last 14 days were on a workspace already `deleted` — the "cost ceiling" bounded nothing.

## Research findings

### F1 — The three branches and what each reads

| Branch | Ages from | Liveness probe? | Escape today |
| --- | --- | --- | --- |
| Ceiling `:1116-1181` | `tasks.started_at` | **no** (deliberate) | supersession only |
| Liveness `:1183-1230` | `tasks.started_at` | yes | `liveness.live \|\| !conclusive` |
| Reconciliation grace `:1258-1275` | `tasks.started_at` | yes | `!conclusive` |

### F2 — Two distinct production row shapes (both in the liveness/grace branches)

Queried the 9 sleeping liveness/grace failures individually:

**Shape A (6 of 9) — the workspace row is gone entirely.**
`tasks.workspace_id IS NULL`, zero `workspaces` rows for the chat session,
`session_snapshots.workspace_id IS NULL` (FK `ON DELETE SET NULL` fired), yet the snapshot is
`sleep_status='sleeping'`, `status='available'`, `degradation='none'`, `recovery_attempts=0`,
`expires_at` in the future. `project_id` survives and still matches `tasks.project_id`.

Why it fails: `classifyTaskRuntimeLiveness` hits `!signals.taskWorkspaceId || !workspace` and
returns `workspace_missing` **conclusive** without ever consulting resumability —
`needsSessionResumabilityProbe` returns `false` for a null workspace, and
`loadSessionResumabilitySnapshot` is keyed `WHERE chat_session_id = ? AND project_id = ? AND
workspace_id = ?`, so it could not find the row even if it ran.

**This is the exact `.claude/rules/58` divergence, one level deeper than the 2026-08-17 fix.**
`claimSessionSnapshotRecovery` (`session-snapshot-recovery-lifecycle.ts:228`) — the real
resumer gate — claims on `chat_session_id` + `user_id` and **never mentions `workspace_id`**.
The destroyer reads a workspace-keyed record; the resumer reads a chat-session-keyed one.

**CORRECTION (found during implementation).** Shape A sessions are NOT wakeable today.
`loadRecoveryContext` (`session-recovery.ts:103`) — the FIRST gate in `ensureSessionRecovery`,
before the claim — requires `snapshot.workspace_id` to be non-null AND the `workspaces` row it
names to still exist AND that row's `user_id` to match. Deleting the workspace row nulls the
snapshot's pointer via `ON DELETE SET NULL`, so the gate can never pass again. The cf-container
path is no escape either: it resolves its target from the same workspace row
(`vm-prompt-delivery-adapter.ts:455`) and `ensureSessionRecovery` short-circuits it with
`container_runtime_wakes_in_place`. 38 of 289 sleeping snapshots are in this state.

`.claude/rules/58` req 2 is explicit that being **looser** than the resumer is its own failure:
preserving a session the wake path will never accept hangs the task until the snapshot TTL
instead of retiring it. So `classifySessionWakeability` mirrors this requirement too, as
`recoveryWorkspacePresent`, and shape A retires — as a **lifecycle `cancelled`**, not a failure.
The underlying wake-path defect is tracked as SAM idea `01M2CQD1FK7YA96VD6Q74302K0`.

What the fix DOES rescue on this path is the variant where `tasks.workspace_id` is null but the
**snapshot** still names a live workspace row — the resumer accepts that, and the pre-fix
classifier did not even probe for it.

**Shape B (3 of 9) — terminalized inside the wake-retry decay window.**
`recovery_attempts=3`, `recovery_status='failed'`, and `tasks.updated_at` is **0, 1 and 3
minutes** after `session_snapshots.recovery_failed_at`. `sessionRecoveryBudgetAvailable`
releases a spent budget once the last clean failure is older than
`SESSION_SNAPSHOT_RECOVERY_ATTEMPT_DECAY_MS` (default **15 min**), so the resumer would have
accepted a wake minutes later. `isSessionResumable` mirrors the resumer *at this instant* and
therefore said "dead" during a refusal that was only ever temporary.

`isSessionResumable`'s own comment justifies instant-equality with "or the task waits out the
full snapshot TTL for a wake that can never happen". That argument holds for **permanent**
refusals (expired, not restorable, already awake). It does not hold for the attempt budget,
whose refusal is bounded by 15 minutes, not by the TTL.

These are the same three sessions (`516141ed`, `b176e912`, `813752af`) already tracked by
`tasks/active/2026-09-10-wake-attempt-budget-strands-sessions.md` as a stranding incident. That
task fixes the resumer side; this one stops the sweep converting the stranding into a permanent
revocation of the guarded wake path.

### F3 — Ceiling rows: the compute was already released

`error_message LIKE 'Task exceeded the absolute runaway-cost ceiling%'`, last 14 days:
79 rows with `workspaces.status='deleted'`, 1 with `'sleeping'`, **zero running**.
`execution_step` is `NULL` and `task_mode='conversation'` on every sleeping ceiling row.
In today's data `workspaces.created_at ≈ tasks.started_at` (one incarnation each), so
re-basing the age alone would **not** have prevented these — the missing gate is the sleep
lookup. Re-basing is still required (idea `01M0SHQDH3FQQG7NMFKMFPSXWM`) so a woken
conversation starts a fresh cost generation instead of inheriting a weeks-old row's age.

### F4 — Failing the task revokes the guarded wake path

`sourceTaskGuardCondition` (`session-snapshot-recovery-lifecycle.ts:43`) requires the source
task NOT be in `['completed','failed','cancelled']`. A guard is supplied for
`sourceKind === 'parent_wakeup'` (`prompt-delivery-runner.ts:216`). So the sweep's verdict
permanently revokes agent-to-agent (parent) wakes for that conversation. Direct user prompts
pass no guard and still wake — which is why the user-visible symptom is the red banner rather
than a dead conversation.

### F5 — `cancelled` already renders as a lifecycle outcome; no UI change needed

`ActiveTaskCard.tsx:126` gates the red `text-danger-fg` "Task failed" line on
`task.status === 'failed'`. `StatusBadge` (`packages/ui/src/components/StatusBadge.tsx:24`)
renders `cancelled` muted. `transitionTaskToTerminal` already supports `cancelled`
(`admissionReason` → `task_cancelled`), and the supersession path already uses it. So item 4
is satisfied entirely in `apps/api/` — **no `apps/web/` or `packages/ui/` change, therefore no
Playwright visual audit is required for this PR.**

### F6 — Do NOT add a `sleeping` execution step

`TASK_EXECUTION_STEPS` feeds `EXECUTION_STEP_LABELS`, `WAKE_PHASE_LABELS` (both exhaustive
`Record`s pinned by tests) and `EXECUTION_STEP_ORDER`. The sweep's candidate query filters on
`status`, not `execution_step`, so a new step would not remove these rows from the candidate
set anyway — the preserve gate is what does that. Decision: **no new status, no new step.**
Recorded here because the task text asked for an explicit decision.

### F7 — Existing coverage and the seam

`apps/api/tests/unit/stuck-task-slept-session-liveness.test.ts` (1127 lines) already covers
`workspace='deleted'` + snapshot present via `getTaskRuntimeLiveness` against
`createSqliteD1`. It seeds `session_snapshots.workspace_id = WORKSPACE_ID`, i.e. only the
shape that already works. It does not enter through `recoverStuckTasks`, so no test observes
the ceiling branch or the real terminal write (`.claude/rules/62`).
`apps/api/tests/unit/stuck-tasks.test.ts` pins "the ceiling terminalizes without probing
liveness" — that property must survive.

## Fix

### 1. One shared wakeability classifier read the way the resumer reads (F2, rule 58)

In `services/task-runtime-liveness.ts`:

- `loadSessionWakeabilityByChatSession(db, projectId, chatSessionId)` — point lookup on the
  unique `idx_session_snapshots_chat_session_id`, scoped `AND project_id = ?` (rule 11;
  F2 confirms `project_id` survives the workspace delete). Replaces workspace-keyed reads.
- `classifySessionWakeability(snapshot, { projectId, budget }) -> 'resumable' | 'retry_pending' | 'unwakeable'`
  - `resumable` — every predicate `claimSessionSnapshotRecovery` enforces holds now.
  - `retry_pending` — only the attempt budget refuses, and it refuses on a **decaying**
    anchor (`recovery_failed_at` finite). Bounded by `expires_at`.
  - `unwakeable` — no row, already awake, not restorable, expired/unparseable expiry, or a
    budget spent with **no** clean failure anchor (never decays → permanent).
- `isSessionResumable(...)` keeps its exact signature and semantics
  (`=== 'resumable'`), so existing behaviour and tests are unchanged.

### 2. Classifier reaches the probe on the deleted/missing-workspace path (F2 shape A)

- `needsSessionResumabilityProbe` fires when the workspace row is **missing or null** too,
  keyed by the task's own `chat_session_id` (same reasoning as the comment already on
  `needsTaskSupersessionProbe`: gating on a column the lifecycle nulls blinds the probe to
  exactly the population it protects — `.claude/rules/63`).
- `workspace_missing` consults wakeability before returning conclusive →
  `workspace_missing_snapshot_resumable` / `workspace_missing_wake_retry_pending`
  (both inconclusive).
- `workspace_<status>` gains the `retry_pending` escape →
  `workspace_<status>_wake_retry_pending`.
- Probe/lookup error still withholds the terminal verdict (rule 58 req 4) — unchanged shape.
- Both adapters (`scheduled/stuck-tasks.ts`, `durable-objects/project-data/task-runtime-liveness.ts`)
  must supply the new signal (rule 58 "every adapter", rule 44).

### 3. One preserve gate at the single terminal choke point (covers all three branches)

In `recoverStuckTasks`, a lazily-cached `probeSessionWakeability()` (one indexed read, paid
only by candidates about to be terminalized — rule 47/58 req 6), consulted at the **single
place `isStuck` becomes actionable**, not in three separate branches. Rationale is the
`.claude/rules/66` lesson already quoted in this file: a per-branch check is exactly what a
future branch forgets.

Applies when `task.status === 'in_progress'` AND
(`task_mode === 'conversation'` OR `execution_step === 'awaiting_followup'`) AND
not a compaction-loop recovery (a real malfunction burning tokens must still terminalize).

- `resumable` / `retry_pending` → log `stuck_task.preserved_sleeping` with task + session ids
  and the outcome, **no status change**.
- `unwakeable` **with a snapshot row present** → terminalize as `cancelled` with a lifecycle
  message, not `failed` (policies `a974b04f`, `486d1dd1`).
- no snapshot row at all → unchanged `failed` (genuine runtime death; this is the
  discriminating control the 2026-08-17 fix relies on).
- lookup error → withhold the verdict, log `stuck_task.wakeability_query_failed`.

`STUCK_TASK_CANDIDATE_COLUMNS` gains `task_mode` (idea's `:247` finding).

### 4. Ceiling ages from the allocated runtime generation (F3, idea `01M0SHQD…`)

`workspaces.created_at` of the task's current workspace, not `tasks.started_at`.
Deliberately the **workspace**, not the agent session: one workspace is one VM allocation,
so agent-session churn inside a live workspace cannot reset the cost bound, while a wake
(which always creates a new workspace) correctly starts a new generation.

- Lookup is paid only by tasks already past `maxExecutionMs`.
- No workspace row → no allocated generation → the ceiling has nothing to bound; skip it and
  fall through to the liveness branch (which now classifies shape A correctly).
- Lookup error → skip the ceiling this tick and log (rule 74 req 5: never silently fall back
  to the ambient proxy). `hardTimeoutMs` + liveness still bound a live runtime.

## Implementation checklist

- [x] `services/task-runtime-liveness.ts`: add `SessionWakeability`,
      `classifySessionWakeability`, `loadSessionWakeabilityByChatSession`; reimplement
      `isSessionResumable` on top of it with unchanged semantics
- [x] `services/task-runtime-liveness.ts`: `needsSessionResumabilityProbe` fires for a
      missing/null workspace; `workspace_missing` + `workspace_<status>` gain the
      `_snapshot_resumable` / `_wake_retry_pending` inconclusive escapes
- [x] `services/task-runtime-liveness-types.ts`: signals carry `chatSessionId` for the
      chat-session-keyed probe
- [x] `scheduled/stuck-tasks.ts`: probe wakeability by chat session in
      `getTaskRuntimeLiveness`
- [x] `durable-objects/project-data/task-runtime-liveness.ts`: same signal wired (rule 44)
- [x] `scheduled/stuck-tasks.ts`: `task_mode` in `STUCK_TASK_CANDIDATE_COLUMNS` +
      `StuckTaskCandidate`
- [x] `scheduled/stuck-tasks.ts`: single preserve gate at the terminal choke point,
      `stuck_task.preserved_sleeping` log, `cancelled` lifecycle label for expired sleeps
- [x] `scheduled/stuck-tasks.ts`: ceiling ages from `workspaces.created_at`; skip + log when
      absent or on lookup error
- [x] File-size check: `stuck-tasks.ts` is 1567 lines with a documented exception; do not
      grow it materially — put new shared logic in the service module
- [x] Tests (below)
- [ ] `pnpm check:fast`, `pnpm typecheck`, `pnpm test`, `pnpm build`

## Tests (`.claude/rules/62` — enter through the real sweep)

New `apps/api/tests/unit/stuck-task-sleeping-conversation-preserved.test.ts`, real
SQLite-backed D1 (`createSqliteD1` + `createSchemaTables`), entering through
`recoverStuckTasks` and asserting on **rows read back from the database**:

1. **Shape A reproduction** — sleeping snapshot, `tasks.workspace_id IS NULL`, no workspace
   row, `started_at` 25 h ago ⇒ task still `in_progress`. RED pre-fix.
2. **Shape A, ceiling** — same, with a workspace row `deleted` and `started_at` 25 h ago
   ⇒ preserved. RED pre-fix.
3. **Shape B reproduction** — `recovery_attempts = max`, `recovery_failed_at` 1 min ago
   ⇒ preserved (`retry_pending`). RED pre-fix.
4. **Liveness-path reproduction** — `execution_step='awaiting_followup'`, workspace deleted,
   240/480-min window ⇒ preserved. RED pre-fix.
5. **Control: live runaway compute** — workspace `running` on a healthy node with a fresh
   heartbeat, `workspaces.created_at` 25 h ago ⇒ still `failed` by the ceiling.
6. **Control: genuinely dead runtime** — workspace deleted, **no** snapshot row
   ⇒ still `failed` by the liveness path.
7. **Control: expired sleep** — snapshot `expires_at` in the past ⇒ terminalized as
   **`cancelled`** with a lifecycle message, never `failed`.
8. **Control: permanent budget refusal** — attempts spent with `recovery_failed_at IS NULL`
   ⇒ `unwakeable` ⇒ terminalized (bounded escape, rule 47).
9. **Scoping** — a snapshot belonging to a different `project_id` must NOT preserve
   (rule 11/28); owner-path control in the same fixture proves the pair discriminating.
10. **Ceiling re-basing** — workspace `created_at` 1 h ago on a 25 h-old conversation row
    with a live runtime ⇒ NOT terminalized by the ceiling (the divergence case, rule 74);
    convergence control: both 25 h ⇒ still terminalized.
11. **Compaction loop still terminalizes** even with a sleeping snapshot.

Each guard deleted once, the intended test confirmed RED, then restored. Record which test
reddened for which guard in the PR.

## Acceptance criteria

- [ ] A sleeping, wakeable conversation older than 24 h is never marked `failed` by any of
      the three branches
- [ ] The liveness classifier returns an inconclusive `_snapshot_resumable` /
      `_wake_retry_pending` verdict when the workspace row is missing or deleted and the
      resumer would still accept a wake
- [ ] A demonstrably live runtime past the ceiling is still terminalized and cleaned up
- [ ] A genuinely dead runtime with no snapshot is still terminalized as `failed`
- [ ] An expired/unwakeable sleep is terminalized as `cancelled` (lifecycle), not `failed`
- [ ] The ceiling ages the allocated runtime generation, not the conversation row
- [ ] Every preserve verdict has a bounded escape (`expires_at`); absent/unparseable bound
      ⇒ terminal
- [ ] Both liveness adapters supply the new signal
- [ ] Production verification SQL trends to zero for rows created after the deploy;
      before/after counts reported in the PR (**before = 41**)

## Verification SQL (production, post-deploy)

```sql
SELECT count(*) FROM tasks t JOIN session_snapshots s ON s.chat_session_id=t.chat_session_id
WHERE t.status='failed' AND s.sleep_status='sleeping'
  AND (t.error_message LIKE 'Task exceeded the absolute runaway-cost ceiling%'
    OR t.error_message LIKE 'Task runtime is no longer live%'
    OR t.error_message LIKE 'Task runtime is conclusively gone%')
  AND t.updated_at >= datetime('now','-7 days');
```
