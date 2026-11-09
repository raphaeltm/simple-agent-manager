# Queue-aware workspace placement

SAM task `01M6YPDWVH009P5R0HX914ATKY` (lead: Opus 5.5 Chat). Coordinator: `01M6YN42K9XB5KVXCTRGJD6QW1`.
Design agreed with the coordinator on 2026-11-08 (agent messages `df54dce3`, reply `b817a35c`).
Full design: idea `01M0FV9VBP8ZATBG2E63R8GD0M`, note `01M6YPTZHDJNRSB0T4WQ51QZJ6` plus the v2 refinements below.

## Problem

Production chat `9d1e9bd0-30ab-4749-ba7b-038ba18339e0` (task `01M6YM58P2MDNZ9N5S1S296JJH`,
node `01M6YKZ7ZQ70K2YVRCZW43014T`) waited 17m00s for the node's single build slot behind five
setups (22:23:56–22:40:57 UTC 2026-11-08). Its own setup took about 3m19s.

User requirements: one build at a time per node; enough resources to build safely. Use the
queued-build count to distribute work to other compatible EXISTING nodes when available. No added
build concurrency, and no extra nodes solely to relieve a queue. Preserve CPU/memory/disk
reservations, fresh telemetry/pressure checks, user isolation, pins/locality, pool authority and
normal capacity-exhaustion behavior.

## Research findings

- R1, ranking: the first-human-start exemption (`user-start-admission.ts`) skips the busy-build
  veto, then `pack` (`placement-strategy.ts`) ranks by projectedUtilization, highest first. Queued
  `creating` rows hold reservations, so the most-queued node ranks HIGHEST.
- R2, signal: the busy-build veto keys on heartbeat `lastMetrics.creatingWorkspaces`
  (`workspace-resource-capacity.ts` `measuredAdmissionDiagnostic`, `workspace-admission-sql.ts`).
  That heartbeat comes every 60s (`HEARTBEAT_INTERVAL`) and counts only dispatched work, so a burst
  inside one window reads 0 and piles onto the top-ranked node.
- The veto originated in #2065 (`tasks/archive/2026-09-11-defer-busy-build-node-placement.md`) as
  a stand-in for "busy", softened to a deferral that, when its 20-minute wait expires
  (`DEFAULT_VM_ADMISSION_BUSY_BUILD_WAIT_TIMEOUT_MS`), provisions a new VM (`node-steps.ts`).
  That is queue-relief provisioning.
- Restart (`routes/workspaces/lifecycle.ts` -> `reserveWorkspaceRestart`) and direct create
  (`routes/workspaces/workspace-create.ts`) get the same veto and return 409 while another
  workspace builds.
- D1 `workspaces.status='creating'` exists from the reservation INSERT (or the restart/attach
  UPDATE) until the ready callback, so it covers reserved, dispatched-building and
  semaphore-waiting work. `loadActiveWorkspaceReservationUsage` already reads those rows with
  their status, so no extra I/O is needed.
- VM semaphore: `packages/vm-agent/internal/server/workspaces.go` `acquireBuildSlot`, depth
  `DefaultWorkspaceBuildQueueDepth = 1`. Unchanged.
- `state.config.vmLocation` is the explicit override OR the first pool candidate/default
  (`services/task-runner-do.ts`). `explicitVmLocation` reaches the start input of every
  `startTaskRunnerDO` caller but is not carried into the TaskRunner config.
- The warm path (`warm-node-claim.ts`) selects `warm_since IS NOT NULL` nodes without checking
  that the node is empty in D1. An ordinary placement can race onto a warm-flagged node before
  NodeLifecycle clears `warm_since`.
- Resource safety: every queued `creating` row holds its full reservation, and the final SQL
  re-checks fresh telemetry, disk, measured-memory overrun, CPU saturation, exclusivity,
  authority and lifetime. Building-container memory counts as unattributed host overhead on top
  of its reservation. That double-counts, which errs safe. No build-demand reservation is needed.

## Design (agreed)

1. Remove the busy-build-only veto globally: the `allowBusyBuildQueue` flag, its SQL param and
   predicate, `WORKSPACE_BUSY_BUILD_QUEUE_REASON`, the `deferrable` outcome,
   `node-placement-deferral.ts`, the busy wait branch, `user-start-admission.ts`, the per-call wait
   timeout, and `VM_ADMISSION_BUSY_BUILD_WAIT_TIMEOUT_MS` plus its default. Keep every
   resource/telemetry/identity/authority/lifetime check. Keep the legacy
   `compatible_node_building_workspace` reason and the `'deferred'` diagnostic outcome readable
   for rows already persisted.
2. Startup backlog = the D1 count of `creating` workspaces on the node.
3. One shared reusable-host comparator, used for warm and occupied ranking:
   - explicit location: location, backlog, strategy
   - incidental location: backlog, location, strategy
   - legacy config without the flag: explicit (today's order)
4. Fairness CAS: when 2+ admitted candidates were ranked, carry `observedStartupBacklog`. The
   reservation INSERT adds `creating count <= observed`. A fairness loss does not count toward
   `workspacePlacementMaxRejections`, is never permanent and replans freshly. After
   `operations.workspacePlacementBacklogConflictRetries` (default 3) conflicts since the last
   successful reservation (capacity refusals neither add to nor reset the count), the next fresh
   selection omits only the fairness predicate. The counter resets on success.
5. Warm shortcut only takes nodes whose D1 startup backlog is 0. A warm-flagged node with queued
   work falls through to ordinary ranking.
6. Diagnostics only: `startupBacklog` on each host diagnostic. No UI change.

## Implementation checklist

- [x] Usage: count `creating` rows (`creatingCount`) in `loadActiveWorkspaceReservationUsage`
- [x] Signals and diagnostics: `startupBacklog` in `PlacementHostSignals` and host diagnostics (shared type optional)
- [x] Remove the busy-build veto from the evaluator, policy and SQL; keep malformed `creatingWorkspaces` validation
- [x] Delete `node-placement-deferral.ts`, `user-start-admission.ts` and the busy-build wait branch in `node-steps.ts`
- [x] Remove the per-call `waitTimeoutMs` option and `busyBuildWaitTimeoutMs` config, the shared constant, the env var, `.env.example`, the omitted-var record and its probe, the env-reference skill and the runtime-tunables baseline
- [x] Shared comparator in `task-placement-strategy.ts`; use it in node selection and the warm claim
- [x] `explicitVmLocation` in TaskRunner config (`task-runner-do.ts`, types)
- [x] Warm shortcut skips nodes with startup backlog > 0
- [x] Fairness predicate `maxStartupBacklog` in `reserveWorkspacePlacement`
- [x] TaskRunner carries `observedStartupBacklog` (2+ candidates only); pin, warm and provisioned paths carry null
- [x] Refusal handler: classify the fairness conflict, don't count it, bounded fallback, reset on success
- [x] Admin setting `operations.workspacePlacementBacklogConflictRetries` (default 3)
- [x] Tests (see acceptance criteria)
- [x] Docs: public docs on placement and build queue (grep), the env reference

## Acceptance criteria

- [x] Comparator: backlog 5 vs 0 and 5 vs 1; idle vs active; ties preserve each strategy; explicit vs incidental location ordering; legacy-absent flag keeps location first
- [x] Every compatible node busy, for human, automated and wake starts: the lowest backlog is chosen without a provider create, including past the old 20-minute deadline
- [x] A node with fewer queued builds that is unsafe (stale telemetry, disk, memory, authority, other user, incompatible) is excluded
- [x] Fairness CAS on real SQL: refused after a concurrent insert; null predicate admitted; decreasing count admitted; discriminating
- [x] Burst on real D1: K starts across 2 idle nodes distribute; a single eligible node takes all K; zero provisions
- [x] A fairness conflict is not counted and not permanent; the bounded fallback keeps capacity guards; the counter resets on success; pins are unaffected
- [x] Restart/direct create on a busy-building node is admitted; a resource-failure control is still refused
- [x] A parked legacy busy-build waiter reselects and places
- [x] Warm vs ordinary interleaving: a warm-flagged node with a queued creating row is not taken by the warm shortcut
- [x] Staging: 2 small nodes, a burst plus a human chat distributes; cleanup verified (see Staging evidence)

Test mapping:

- Comparator, all-busy starts, unsafe exclusions, location, warm interleaving, pin and legacy
  waiter (mocked orchestration): `tests/unit/durable-objects/task-runner-node-selection.test.ts`,
  "startup backlog ranking"
- Real D1 selector, including a different user's idle node never being ranked:
  `tests/workers/workspace-resource-capacity-races.test.ts`. Authority exclusion is covered by
  `task-runner-reuse-scoping.test.ts` and `placement-authority-effective-pool.test.ts`, which are
  unchanged and still pass.
- Fairness CAS, burst, restart on a building node (real SQLite):
  `tests/unit/services/workspace-placement.test.ts`, "startup backlog fairness guard"
- Conflict loop, capacity refusal vs conflict, bounded fallback keeping capacity guards, legacy
  waiter closing its admission row (real DO + D1):
  `tests/workers/startup-backlog-placement-loop.test.ts`; budget and reset:
  `tests/workers/provisioned-node-placement-admission.test.ts`
- `explicitVmLocation` wiring: `tests/unit/task-runner-do-service.test.ts`

## References

- `.claude/rules/62`, `.claude/rules/74`, `.claude/rules/73`, `.claude/rules/81`
- `apps/api/.claude/rules/69-aggregate-capacity-at-final-reservation.md`, `61-per-cycle-budget-counters.md`, `47-control-loop-io-budget.md`

## Implementation notes

- `startupBacklog` is counted in `loadActiveWorkspaceReservationUsage` (`status = 'creating'`) and in the
  `active_reservations` CTE of the atomic SQL (`startup_backlog`). No extra round-trips.
- The guard is stored as `stepResults.rankedStartupBacklog = { nodeId, backlog }` through
  `adoptReusableNodeSelection()`, so a stale value never guards a different node.
- The fairness fallback reads `operations.workspacePlacementBacklogConflictRetries` only when the
  run already has a conflict.
- Discrimination verified (each reverted once, the named tests went red):
  - comparator backlog key: 7 node-selection unit tests plus the real-D1 selector test
  - warm `startupBacklog > 0` skip: the warm interleaving test
  - SQL fairness predicate: the refuse/control test and the two-node burst
  - restoring the old busy veto in SQL: building-node admission, burst, single-node burst, restart
  - conflicts counted as rejections: the replan-without-budget test
  - fallback bound removed: the drop-guard-after-N test

## Staging evidence

Deploy of `404b5ae4d284f50f5866daee008891cf419b27bc` (run 42550155973). Two idle cx23 nodes owned
by the smoke user: A `01M6Z2AYM28MK64SDVG4PJ7260`, B `01M6Z2B15R4112HG0BTB9SJF63`. B already held
one running workspace from an earlier submit, so `pack` ranks B first by utilization.

Burst at 02:44:49Z on 2026-11-09: three tasks and one conversation, 250 ms apart, all inside one
heartbeat window (both nodes reported `creatingWorkspaces: 0`). Results from D1:

| Task                         | Mode         | Node | Ranked backlogs (A, B)       | Note                                                            |
| ---------------------------- | ------------ | ---- | ---------------------------- | --------------------------------------------------------------- |
| `01M6Z33B70TP1AFMA8J28BPW6V` | task         | B    | B: 0 (only candidate ranked) |                                                                 |
| `01M6Z33BVH367P1J00Q1PAA6KM` | task         | A    | 0, 0 (B rejected)            |                                                                 |
| `01M6Z33BY0SWJF6ZMFQPSFP41N` | task         | A    | 1, 1                         | fairness conflict on A (0 when ranked, 1 now), replanned        |
| `01M6Z33BYF1ZG9BGEY4P6XNM2Y` | conversation | B    | 2, 1                         | fairness conflict on A (1 when ranked, 2 now), replanned onto B |

Per node: A 2, B 2. Nodes created since the burst: none. Conflicts were not counted toward the
refusal budget (`0/3` in the note).

An earlier simultaneous burst at 02:38:15Z had 3 of 4 submits fail with 500 in
`project_authorization` (transient D1 error), before placement code runs. That path is not
changed here; filed as `tasks/backlog/2026-11-09-task-submit-transient-d1-500.md`.
