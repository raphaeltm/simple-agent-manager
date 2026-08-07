# Fix idle-cleanup sweep silently terminalizing in-flight tasks as `completed`

**Status**: active
**Created**: 2026-08-06
**Idea**: `01KZAB5CYEHWAN4ZT8YSG2N9QG`
**Branch**: `sam/fix-platform-idle-cleanup-prarzs`

## Problem

The ProjectData Durable Object idle-cleanup sweep terminalizes **in-flight** tasks as
`status='completed'` with a **null `output_summary`**, **null `error_message`**, and **no
`task_status_events` row** — while the agent runtime is still alive and working.

User-visible impact: a parent orchestrator polling `get_task_details` sees `completed` with no
summary and cannot distinguish "succeeded but summary missing" from "silently killed". Active
`/do` orchestration work was destroyed twice on 2026-08-06 and recovery agents had to be
dispatched by hand. This undermines every long-running orchestrator (shepherd crons,
verification-train conductors) and blocks scaling scheduled orchestration.

## Root Cause (proven against production D1)

`completeTaskInD1()` — `apps/api/src/durable-objects/project-data/idle-cleanup.ts:346-362`:

```sql
UPDATE tasks SET status = 'completed', execution_step = NULL, completed_at = ?, updated_at = ?
WHERE id = ? AND status IN ('in_progress', 'delegated', 'awaiting_followup')
```

Four defects in one statement:

1. **Wrong terminal state.** A sweep-driven terminalization is not a success. It writes `completed`.
2. **No diagnostic context.** No `error_message`, no `output_summary`, and no `task_status_events`
   row — the audit history simply stops before the terminal transition.
3. **No runtime-liveness gate.** The decision is made purely from DO-local activity timestamps.
   The runtime owner is never asked whether the agent is conclusively terminal.
4. **Not reporter-scoped** (Path B). `SELECT id FROM tasks WHERE workspace_id = ? AND status IN
   ('in_progress','delegated') LIMIT 1` picks an arbitrary row with no ordering and no project scope.

### Two calling paths, both from the ProjectData DO `alarm()`

| Path | Function | Timer | Scoping |
|---|---|---|---|
| **A** | `processExpiredCleanups` (line 128) | `SESSION_IDLE_TIMEOUT_MINUTES` = **60** (`apps/api/wrangler.toml:26`) | reporter-scoped (`idle_cleanup_schedule.task_id`) |
| **B** | `checkWorkspaceIdleTimeouts` (line 277) | `DEFAULT_WORKSPACE_IDLE_TIMEOUT_MS` = **2h** | **not** reporter-scoped (`LIMIT 1`) |

Path A is armed for **task-mode** tasks by `task-runner/state-machine.ts:73-86`. Its clock is reset
**only** by message persistence (`message-persistence.ts:56,112`) or the manual browser
`/idle-reset` route. Tool calls, terminal activity, ACP heartbeats, git/CI work — none reset it.
An agent that is working hard but not emitting persisted chat messages looks idle.

Path B computes `lastActivity = max(last_terminal_activity_at, last_message_at, session_updated_at)`
— the same blind spot, on a 2h fuse.

Introduced by PR #1008 (2026-05-14, commit `1704a4b2e`). Its own comment says the intent was
conversation-mode cleanup, but the query has **no `task_mode` filter**, so it also sweeps task-mode
`/do` tasks that `reconciliation.ts` is documented to own.

## Evidence

Queried production D1 (`sam-prod` `a8923a52-b1d4-4e0d-9bd9-aa5406face5e`, account
`e2eb9a8d5b560cce006fdd03ad6f2e49`) with `$CF_PRODUCTION_DEBUGGING_TOKEN`.

**Timing matches the timers exactly.**
- 00:48:59 / 00:49:00 / 00:49:02 / 00:49:03 — four tasks in a 5s window. Agents went quiet ~22:49;
  22:49 + 2h = 00:49 → Path B, one DO alarm iterating a batch of workspaces.
- 02:55:59 (`01KZAB34WER2DZ43YBZ541336Q`) and 03:39:12 (`01KZADBXXXP9FT8EQN5P45XRB3`) — last persisted
  message + 60 min → Path A. Matches the idea's observed "~1h–1h15m" grace period.

**`execution_step` is a perfect discriminator.** Over the last 30 days of task-mode completions:

| Group | `execution_step` | Count |
|---|---|---|
| `output_summary IS NULL` (swept) | `NULL` | **36** |
| `output_summary IS NOT NULL` (healthy) | `running` / `awaiting_followup` / `agent_running` | **406** |

`completeTaskInD1` is the only writer that nulls `execution_step` while writing `completed`.
(`_helpers.ts:setTaskStatus` also nulls it but always appends a status event; `crud.ts:708` is
conversation-mode only and appends a status event. Neither matches.)

**The runtime was alive when swept.**
- All three hosting nodes (`01KZ9YVQSEWC18H9DDC26PRXCT`, `01KZA08NXHX54CGXRDZGAGX9DH`,
  `01KZA098X9R3ZXX85XKKDAN0M3`) are still `status=running`, `health_status=healthy`, heartbeating
  hours after the sweep.
- Every `agent_sessions` row for the five swept workspaces is still `status='running'`. The runtime
  owner never reported a terminal lifecycle.
- Each workspace was set `stopped` within <1s of its task's `completed_at` — `deleteWorkspaceInD1`
  and `completeTaskInD1` in the same loop iteration.

**Blast radius**: 36 task-mode tasks silently swept in 30 days (~8% of task-mode completions).

## Research Findings

1. **A correct in-repo pattern already exists.** `reconciliation-dead-target.ts:failTaskAndWorkspace`
   writes `status='failed'` + `error_message`, project-scoped. Follow it. → checklist 3, 4
2. **A `{live, conclusive, reason}` classifier already exists**: `getTaskRuntimeLiveness`
   (`scheduled/stuck-tasks.ts:422`), which correctly treats sleep/recovery/probe-timeout/unknown as
   **inconclusive**. But it reads ACP sessions via `projectDataService.listAcpSessions` — an **RPC to
   ProjectData**. Calling it from inside the ProjectData DO's own alarm would be self-reentrant.
   → extract a pure classifier + a DO-local adapter. → checklist 1, 2
3. **The DO can read ACP sessions locally and synchronously**: `acp-sessions.ts:listAcpSessions(sql, opts)`.
   → checklist 2
4. **ACP heartbeat is a genuine liveness signal**, independent of chat activity: the VM agent posts
   every `ACPHeartbeatInterval` (default **60s**, `vm-agent/internal/config/config.go:505`) via
   `startAcpHeartbeatReporter`. This is exactly the signal the current sweep ignores. → checklist 2
5. **Ownership overlap**: `reconciliation.ts` documents its exclusions as "Conversation-mode tasks
   (handled by workspace idle timeout)", i.e. task-mode belongs to reconciliation, which fails tasks
   properly. Path B has no `task_mode` filter and steals them. Decision: do **not** add a `task_mode`
   exclusion (that would risk regressing the 2026-05-13 fix for conversation tasks stuck
   `in_progress`); the liveness gate is the real protection and applies uniformly. Document the
   ownership in comments. → checklist 5
6. **Four terminal writers emit no `task_status_events` row**: `idle-cleanup.ts:346`,
   `attention-expiry.ts:69`, `reconciliation-dead-target.ts:89`, `project-orchestrator:cancelMission`.
   Fixing all four is out of scope; this task fixes `idle-cleanup.ts` and files the rest.
   → checklist 9 (deferred, see Follow-ups)
7. **Rule 47 applies**: adding a liveness probe per candidate inside a DO alarm adds bounded network
   I/O to a control loop. Needs a tiered env-configurable timeout, a bounded candidate count, and a
   documented escape path. Candidate selection changes ⇒ two-sweep zombie test required.
   → checklist 6, 8

## Implementation Checklist

- [x] 1. Extract a **pure** shared lifecycle classifier `classifyTaskRuntimeLiveness(signals)` into
      `apps/api/src/services/task-runtime-liveness.ts` (types + status sets + decision rules). Sleep,
      wake, restore, replacement, probe failure and unknown MUST classify as `conclusive: false`.
- [x] 2. Add two adapters over the same classifier: the existing cron-side `getTaskRuntimeLiveness`
      (moved, re-exported from `stuck-tasks.ts` so existing imports/tests keep working) and a new
      **DO-local** adapter that reads `acp_sessions` from `this.sql` (no RPC re-entrancy) and
      workspace/node rows from D1.
- [x] 3. Replace `completeTaskInD1` with a gated `terminalizeIdleTaskInD1` that: loads the task,
      enforces reporter/project scoping, consults the shared classifier, and **only** terminalizes
      when `conclusive && !live`. Preserve (skip) on live or inconclusive.
- [x] 4. Terminalize as `status='failed'` with a diagnostic `error_message` naming the sweep, the
      idle duration, the configured timeout and the conclusive liveness reason; include
      `project_id = ?` in the write predicate; insert a `task_status_events` row; sync trigger
      execution status to `failed`.
- [x] 5. Make Path B reporter-scoped: replace the arbitrary `LIMIT 1` with a deterministic, bounded
      selection of the active tasks for that workspace, each terminalized through the gated path.
      Gate the destructive `deleteWorkspaceInD1` on the same conclusive-death result.
- [x] 6. Add env-configurable bounds with `DEFAULT_*` constants (constitution XI): candidates per
      sweep and the liveness probe timeout. No hardcoded values.
- [x] 7. Update `apps/api/tests/unit/conversation-idle-timeout.test.ts` for the new contract
      (its current assertions encode the buggy `completed` behavior).
- [x] 8. Tests (see Acceptance Criteria) — reporter-scoped regression tests, liveness-gate tests,
      two-sweep zombie test, diagnostic-context tests.
- [x] 9. Post-mortem + process fix (rule 02 requires both in the same PR).
- [x] 10. Doc sync: update any docs describing idle-timeout task completion semantics.

## Acceptance Criteria

- [x] A sweep never terminalizes a task whose runtime is `live` or whose liveness is **inconclusive**
      (sleeping, recovering, waking, restoring, probe timeout, probe error, unknown).
- [x] A swept task becomes `failed`, never `completed`, and always carries a non-null
      `error_message` naming the sweep + the conclusive liveness reason.
- [x] Every sweep terminalization writes a `task_status_events` row (`actor_type='system'`).
- [x] **Reporter-scoped** (rule 02): a newer unrelated active task on the same workspace/project is
      NOT terminalized; only the entity the reporter attested to is.
- [x] **Two-sweep zombie test** (rule 47): a permanently-live candidate is not re-terminalized and
      does not accumulate; a permanently-dead candidate leaves the candidate set after one sweep.
- [x] Project-scope guard: a task belonging to another project is rejected and logged with
      `action: 'rejected'` (rule 11), and no row is mutated.
- [x] The regression tests are **discriminating** — verified to fail against the pre-fix code.
- [x] `pnpm lint && pnpm typecheck && pnpm test && pnpm build` all green.
- [x] Staging: deploy, exercise a real task, confirm no silent `completed` sweep; delete all staging
      nodes/workspaces immediately after (zero-at-rest, Hetzner 10-server shared limit).
      Evidence: candidate staging deploy `31137108222` passed at `b2fcea7ee`, CI passed on PR #1760,
      and final candidate redeploy `31146117906` passed at `de9f8bbbd`. Controlled real-task probes
      `01KZCX7S44HMCX17TB1ENNQW3M` and `01KZCXDM3AWJBQWDNGGQR5FRBX` provisioned staging nodes but
      the VM agent never heartbeated before workspace execution; both were explicitly cancelled and
      deleted via the API. A/B control on current `main` (`31145298435`, task
      `01KZD60ZZ1WWE02ME85799TSV9`) reproduced the same no-heartbeat/no-workspace behavior, proving
      the staging VM bootstrap issue is not introduced by this idle-cleanup PR. All probe tasks had
      `silent_completed=0`; final staging D1 state had `running_nodes=0` and `running_workspaces=0`.

## Post-mortem

### What broke

ProjectData's two idle-cleanup paths treated the absence of persisted chat or terminal activity as
proof that a task had succeeded. They wrote `completed` directly, erased `execution_step`, supplied
no summary or error, emitted no status event, and immediately stopped/deleted workspace state even
while the runtime owner still reported active work.

### Root cause

PR #1008 (`1704a4b2e`, 2026-05-14) introduced `completeTaskInD1()` for conversation cleanup. The
implementation conflated a resource-idleness timer with task lifecycle authority and Path B selected
an arbitrary task by workspace. Later callers armed the same path for task-mode work, but neither
the original contract nor its tests required a runtime-owner liveness decision.

### Incident timeline

- 2026-05-14: PR #1008 introduced the unsafe direct completion writer.
- 2026-08-06 00:48–00:49 UTC: a Path B sweep terminalized four active tasks at the two-hour timer.
- 2026-08-06 02:55 and 03:39 UTC: Path A terminalized two more active tasks at the one-hour timer.
- The recovery task `01KZB1G2KNKPTRMKMDBX3Q0Q3R` was itself falsely marked complete with null output.
- This branch recovered the durable research record, reproduced the bug against pre-fix behavior,
  and replaced both writers with one shared runtime-liveness contract.

### Why existing tests missed it

The old idle-timeout tests asserted the buggy `completed` mutation and workspace deletion. They did
not cross D1, ProjectData SQLite, and runtime lifecycle boundaries, did not seed a live ACP session,
and did not assert status-event or trigger-execution parity. Path B's arbitrary `LIMIT 1` was also
represented by permissive mocks rather than stateful same-workspace rows.

### Bug class and process fix

This was a cross-control-plane lifecycle-authority bug: a stale activity replica overruled the
runtime owner. `.claude/rules/02-quality-gates.md` now states that inactivity is never successful
completion evidence, requires explicit success, and requires conclusive-death failure diagnostics,
system status events, trigger synchronization, and the same gate for workspace deletion. The new
tests use real in-memory SQLite at both storage boundaries and share the pure classifier exercised by
cron-side and DO-local adapters.

## Follow-ups (out of scope, filed)

- [`attention-expiry.ts` missing events](../backlog/2026-08-06-attention-expiry-task-status-events.md)
- [`reconciliation-dead-target.ts` missing events](../backlog/2026-08-06-reconciliation-dead-target-task-status-events.md)
- [`ProjectOrchestrator.cancelMission()` missing events](../backlog/2026-08-06-project-orchestrator-cancel-status-events.md)
- [Staging VM-agent no-heartbeat before workspace creation](../backlog/2026-08-07-staging-vm-agent-no-heartbeat-before-workspace.md)
- Idle-cleanup clock only advances on message persistence; consider advancing it on ACP heartbeat /
  tool activity so the *timer* also reflects real work, not just the terminalization gate.
- Backfill/relabel the 36 historically mis-terminalized production tasks.

## References

- Idea `01KZAB5CYEHWAN4ZT8YSG2N9QG`
- `.claude/rules/02-quality-gates.md` — runtime liveness across control planes; reporter-scoped
  reconciliation; regression + process-fix requirements
- `.claude/rules/47-control-loop-io-budget.md` — control-loop I/O budget, two-sweep zombie test
- `.claude/rules/11-fail-fast-patterns.md` — project-scoped writes, structured rejection logging
- `.claude/rules/03-constitution.md` — Principle XI, no hardcoded values
- Introduced by PR #1008 (commit `1704a4b2e`)
