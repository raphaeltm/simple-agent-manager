# Fix Scheduler Sleep Leaks And Node Pool Migration Gaps

## Problem

Production has completed work that still consumes resources and exposes stale
legacy node-size identity after the capacity pool rollout.

Observed production state on 2026-08-31:

- 17 workspace rows were still creating/running: 4 legitimate or provisioning,
  2 recent cf-container completions still in normal sleep grace, 7 terminal
  tasks stranded on live nodes, and 4 ledger-only rows whose nodes were already
  deleted.
- The 7 stranded sleep snapshots were `status='available'`,
  `sleep_status='stopping'`, `sleep_attempts=1`, with
  `ProjectData refused the durable sleeping transition`.
- 6 stranded workspaces kept 2 otherwise-empty pool-backed Hetzner `cx23` nodes
  alive; the 7th shared a legacy recovery node with active work.
- D1 `agent_sessions` had additional stale `running`/`recovery` rows, and open
  `compute_usage` rows existed on deleted nodes.
- Pool-backed nodes stored `provider_instance_type='cx23'`, but APIs/UI exposed
  only legacy `vmSize`. Metering derived vCPU from `small`/`medium`; production
  had `medium=4` vCPU usage on actual 2-vCPU `cx23` nodes.
- A session recovery task created a post-pool `medium` node with no
  `capacity_pool_id` or provider instance metadata.

## Root Cause

The production ordering is:

1. `task-terminal-cleanup.ts` queues sleep immediately for completed task chats.
2. `scheduled/handler.ts` runs `terminal_session_ledger_reconciliation` before
   `session_sleep`.
3. `terminal-session-reconciliation.ts` only defers fully sleeping snapshots
   (`sleeping_at IS NOT NULL AND sleep_status='sleeping'`), then stops terminal
   task chats.
4. `ProjectData.sleepSession()` only transitions `status='active'`, so the later
   sleep sweep cannot complete the durable session transition after the chat was
   stopped.
5. `scheduled/session-sleep.ts` reselects `stopping` rows in a way that is
   attempt-cap exempt, creating a durable wedge without an absolute ceiling.

The same too-narrow `sleep_status='sleeping'` predicate exists in multiple
destroyer paths. Session recovery also bypasses the centralized placement
resolver and starts `TaskRunner` with legacy `vmSize` only.

## Fable Approval

Fable gate sequence:

- `01M1CG1ZNYKS2FX53JBMS5Y6E0` failed before starting after queueing at node
  selection for 1385s.
- `01M1CHF939QC5DQZEC5DAHYBFW` completed read-only review with
  `CHANGES REQUIRED`.
- `01M1CK9NX0FQBM96X2VWG8E4HH` approved the amended plan.

Approval constraints to preserve:

- Use one shared restorable-or-in-flight sleep predicate across all three
  `sleeping`-only destroyer guards.
- Add an env-configurable absolute ceiling and escape path for wedged in-flight
  sleeps.
- Resolve session recovery placement exactly once through the shared resolver,
  before consuming recovery attempts, and feed both snapshot/ledger columns and
  `TaskRunner` configuration.
- Distinguish positively invalid pool configuration from transient resolver
  failures.

## Research Findings

Relevant code paths:

- `apps/api/src/services/task-terminal-cleanup.ts` queues immediate sleep on
  completed task chats and can call `stopSession`/`failSession`.
- `apps/api/src/scheduled/handler.ts` orders terminal ledger reconciliation
  before session sleep.
- `apps/api/src/durable-objects/project-data/terminal-session-reconciliation.ts`
  uses a `sleep_status='sleeping'` only predicate before `stopSession` or
  `failSession`.
- `apps/api/src/scheduled/session-summary-ledger-reconciliation.ts` duplicates
  the same predicate in both read and SQL CAS update forms.
- `apps/api/src/services/session-snapshot-recovery-lifecycle.ts` and
  `apps/api/src/services/workspace-lifecycle-finalizer.ts` guard finalization
  with the same `sleeping`-only snapshot check.
- `apps/api/src/services/task-runtime-liveness.ts` has a
  `RESUMABLE_SLEEP_STATUS='sleeping'` classifier escape consumed by stuck-task,
  idle-cleanup, and dead-target paths; this must be dispositioned explicitly.
- `apps/api/src/services/session-recovery.ts` claims recovery before resolving
  fresh placement and starts `TaskRunner` without `capacityPoolSelection`.
- `apps/api/src/services/placement-resolver.ts`,
  `placement-resolver-capacity.ts`, and `placement-resolver-types.ts` already
  provide central capacity pool selection and credential attribution surfaces.
- `apps/api/src/services/task-runner-do.ts` already accepts
  `capacityPoolSelection` and snapshots provider instance metadata into task
  starts.
- `apps/api/src/services/compute-usage.ts` snapshots only `server_type` and
  vCPU from legacy `vmSize`.
- `apps/api/src/services/node-usage.ts` derives vCPU from legacy `vmSize`.
- `apps/api/src/routes/nodes.ts` and `packages/shared/src/types/workspace.ts`
  expose legacy node/workspace identity more prominently than provider-native
  offering metadata.
- Latest D1 migration is `0131_session_summary_terminal_reconcile_markers.sql`;
  new D1 changes must be additive.

Relevant rules and post-mortems:

- `.claude/rules/31-migration-safety.md`: never recreate FK parents; additive
  migrations only.
- `.claude/rules/44-dual-write-migration-enumerate-writers.md`: enumerate every
  lifecycle writer and route through shared finalizers or explicitly allowlist.
- `.claude/rules/47-control-loop-io-budget.md`: every selected candidate needs
  a terminal or expiring escape path and maximum residence time.
- `.claude/rules/53-scheduled-handler-isolation-and-liveness-signals.md`:
  precondition deferrals must not consume destructive retry budgets or become
  immortal retry states.
- `.claude/rules/58-terminal-verdicts-must-match-the-resumer.md`: destroyers
  must read the same recovery artifact as the resumer and preserve recoverable
  work with a bounded escape.
- `.claude/rules/61-guards-must-cover-every-runtime.md`: cross-runtime
  preconditions and guards belong in shared services with enumeration tests.
- `.claude/rules/67-shared-predicates-that-trigger-actions.md`: enumerate
  callers before widening predicates that drive actions.
- `tasks/archive/2026-08-17-fix-slept-session-classified-as-dead.md` and
  `tasks/archive/2026-08-27-workspace-based-node-cleanup.md`: prior
  destroyer/resumer divergence and cleanup lessons.
- `tasks/archive/2026-08-26-fix-reconciliation-checkin-attention-expiry.md`:
  destructive lifecycle expiry must require durable delivery/liveness evidence.
- `tasks/archive/2026-08-30-record-task-supersession-active-agent-counts.md` and
  `tasks/archive/2026-08-30-repair-sams-stale-session-hh4efq.md`: stale agent
  and session ledger repair context.

## Writer Inventory And Disposition

`ProjectData` mutators:

- `apps/api/src/durable-objects/project-data/sessions.ts` owns the low-level
  `stopSession`, `failSession`, and `sleepSession` writes. These remain narrow
  primitives; caller-side lifecycle gates decide whether a session is
  destroyable, failed, or should stay/wind up sleeping.
- `apps/api/src/durable-objects/project-data/index.ts` exposes the public RPC
  surface. No duplicated sleep predicate belongs here.

Sleep-aware destroyers:

- `apps/api/src/durable-objects/project-data/terminal-session-reconciliation.ts`
  now uses the shared SQL-capable restorable-or-in-flight predicate before
  `stopSession`/`failSession`.
- `apps/api/src/scheduled/session-summary-ledger-reconciliation.ts` now uses the
  same shared predicate in both its read path and its compare-and-swap SQL
  update path.
- `apps/api/src/services/workspace-lifecycle-finalizer.ts` now uses the same
  shared predicate before ProjectData stop/fail. It still closes explicitly
  non-protected lifecycle rows and destructive delete/archive paths remain
  destructive after their snapshot state is deleted.

Sleep lifecycle writers:

- `apps/api/src/scheduled/session-sleep.ts` remains the normal scheduled sleep
  executor. It reclaims stale `preparing` claims and rolls stale `stopping`
  claims forward through the existing point-of-no-return path without consuming
  another pre-teardown retry attempt.
- `apps/api/src/scheduled/session-sleep-lifecycle-repair.ts` is the bounded
  escape for already-stranded post-capture rows. It repairs only stale
  `preparing`/`stopping` rows that already have restorable, unexpired snapshot
  data, marks ProjectData/workspace/agent-session state as sleeping, closes
  compute usage, and never wakes or replays work.
- `apps/api/src/scheduled/terminal-node-lifecycle-repair.ts` skips rows
  protected by the shared predicate so terminal-node cleanup does not break an
  in-flight sleep lifecycle before the repair/sleep sweep can converge it.

Intentional non-sleep destroyers:

- `apps/api/src/services/task-terminal-cleanup.ts`,
  `apps/api/src/services/task-runner.ts`,
  `apps/api/src/services/instant-session.ts`,
  `apps/api/src/routes/tasks/run.ts`,
  `apps/api/src/routes/tasks/submit.ts`,
  `apps/api/src/services/trigger-submit.ts`, and
  `apps/api/src/routes/mcp/orchestration-tools.ts` perform startup failure,
  explicit archive/delete, or no-restorable-snapshot cleanup. These paths either
  create the sleep intent instead of stopping the chat, route through the shared
  finalizer, or intentionally destroy after snapshot state has been removed.
- `apps/api/src/scheduled/d1-retention.ts` expires/purges old snapshot artifacts
  after TTL and is deliberately destructive.
- `apps/api/src/services/agent-activity-callback.ts` cancels/updates sleep
  lifecycle intent on resumed activity; it is not a ProjectData destroyer.
- `apps/api/src/services/task-runtime-liveness.ts` keeps
  `RESUMABLE_SLEEP_STATUS='sleeping'` intentionally. That classifier answers the
  different question "can this task be considered resumable right now?" for
  stuck-task/dead-target verdicts, and must match the resumer's final
  `sleeping_at IS NOT NULL AND sleep_status='sleeping'` wake gate. It should
  not include in-flight states because those are preserved/repaired by the
  scheduler/finalizer gates, not treated as fully wakeable slept sessions.

## Implementation Checklist

- [x] Create a shared SQL-capable restorable-or-in-flight sleep lifecycle
      predicate/helper that can be scoped by project/session and by
      project/session/workspace where needed.
- [x] Include retry-eligible `failed` snapshot sleep states in the in-flight
      defer set where they can still roll forward safely.
- [x] Replace the three `sleeping`-only destroyer guards with the shared
      predicate: terminal session reconciliation, session-summary reconciliation
      read/CAS, and workspace lifecycle finalization.
- [x] Add an env-backed `DEFAULT_*` absolute in-flight sleep ceiling with
      per-cycle anchoring that resets on successful progress.
- [x] Add a bounded escape path for wedged `preparing`/`stopping`/retryable
      `failed` sleep rows that routes restorable wedges into the repair path
      rather than archiving recoverable sessions.
- [x] Add deterministic, idempotent repair for already-stranded terminal
      sessions/snapshots without waking or replaying work.
- [x] Add deterministic, bounded cleanup for stale workspace, agent-session,
      and open `compute_usage` rows when the owning node is terminal/deleted.
- [x] Route session recovery placement through the centralized resolver before
      consuming recovery attempts.
- [x] Feed resolved placement metadata into both recovery-task snapshot columns
      and `TaskRunner` `capacityPoolSelection`.
- [x] Preserve supersession/source-task CAS semantics during recovery handoff.
- [x] Fail wake visibly for positively invalid pool configuration and defer
      transient resolver/provider failures without consuming
      `recovery_attempts`.
- [x] Add provider-native instance metadata columns to `compute_usage` through
      an additive migration and snapshot those values when tracking starts.
- [x] Use provider instance vCPU count for compute and node usage accounting,
      with `getVcpuCount` only as legacy fallback.
- [x] Extend shared/API node and workspace response types with authoritative
      provider offering identity/resources.
- [x] Update affected UI surfaces to display provider-native instance identity
      and resources as authoritative; keep `small`/`medium`/`large` labeled as
      compatibility/request hints.
- [x] Determine deployment-node capacity-pool scope from current architecture.
      If deployment nodes intentionally remain outside pools, document and
      label that scope. If not, route them through the same resolver.
- [x] Add unit/integration tests for exact production sweep ordering:
      terminal cleanup queues sleep, terminal ledger sweep runs, summary ledger
      sweep runs, sleep sweep completes, and node can warm/destroy without a
      stuck `stopping` snapshot.
- [x] Add tests for all three predicate guard sites, ceiling/escape behavior,
      recovery invalid-vs-transient pool errors, metering overlap with
      provider vCPU metadata, deleted-node orphan usage closure, and writer
      inventory coverage.
- [x] Update docs and PR evidence for lifecycle semantics, provider-native node
      identity, metering behavior, and deployment-node pool scope.
- [ ] Run local quality suite, local specialist reviews, UI screenshots if UI
      files change, staging on a final pinned candidate with zero staging VMs at
      rest, PR, CI, CodeRabbit label loop, merge, and production deploy
      monitoring.

## Acceptance Criteria

- Completed terminal tasks can no longer stop a ProjectData chat while an
  authoritative sleep lifecycle can still complete.
- Existing stranded `stopping` snapshots converge through a bounded repair path
  without waking/replaying work or archiving restorable sessions.
- Stale `workspaces`, `agent_sessions`, and `compute_usage` rows tied to
  terminal/deleted nodes are repaired deterministically.
- Session recovery creates pool-backed replacement tasks/nodes when an
  effective pool exists, uses the project/user/installation precedence once,
  and fails closed on positively invalid project pools.
- Transient recovery placement errors do not consume recovery attempts.
- API/UI no longer present legacy `small`/`medium` as the authoritative identity
  for pool-backed concrete offerings.
- Compute and node usage use provider instance vCPU metadata when available;
  legacy fallback remains for old rows.
- Deployment-node pool scope is either implemented through the central resolver
  or explicitly documented as intentionally outside workspace pools.
- Tests cover the production race, three guard sites, bounded convergence,
  recovery placement, metering, and writer inventory.
- D1 migrations are additive and pass migration safety checks.
