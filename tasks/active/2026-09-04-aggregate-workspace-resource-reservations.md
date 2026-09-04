# Enforce aggregate workspace reservations during VM node placement

## Context

Production node `01M1M765QGSXG0NKSTRXDR32FF` was a Hetzner `cx23` with 2 vCPU and
4096 MB RAM. Three workspaces were placed on it while each task carried the same
resolved reservation (`2000` mCPU, `4096` MB memory, `40960` MB disk). The
count-only `MAX_WORKSPACES_PER_NODE=3` guard admitted all three; the node later
reported 98.8% memory and a 40.26 one-minute CPU load before heartbeat starvation
and two false failures.

This task completes the aggregate-accounting slice of ideas
`01KWVZKB5K7V02GZT3X3G0CWMZ` and `01KRAHJ0R7Y9N0EVS27JKYT8PF`. It builds on
merged PR #1876 (`92b485644`, concurrency-safe admission/slot reservation) and
merged PR #1943 (central placement resolution and provider-native capacity). It
must not introduce another allocator, resource-requirement resolver, or SKU table.

## Research findings

- `resolveTaskStartPlacement()` is the single resource-requirement resolver. Its
  exact `resolvedReservation` is persisted on the task and passed through
  `TaskRunConfig` by submit, run, trigger-submit, SAM dispatch/retry, mission
  scheduling, session recovery, and both MCP dispatch paths.
- `createAndProvisionWorkspace()` receives that snapshot but
  `reserveWorkspacePlacement()` omits `workspaces.resolved_reservation_json`.
- Reusable-node selection checks one request against the node's total capacity,
  then uses only an active-workspace count. It does not subtract reservations.
- The final D1 `INSERT ... SELECT` correctly proves assignment, state, tenant and
  capacity-pool scope atomically, but its capacity predicate is also count-only.
- `nodes.provider_instance_vcpu_count`, `provider_instance_memory_mb`, and
  `provider_instance_disk_gb` are the authoritative concrete capacity snapshot
  introduced by the compute-pools work. `workspaces.resolved_reservation_json`
  already exists, so no schema migration is needed.
- Active placement occupants are `running`, `creating`, and `recovery`;
  `stopped` and `deleted` release capacity.
- Other direct `creating` workspace writers are the manual workspace route, the
  dedicated trial orchestrator, and instant container sessions. They do not pass
  through TaskRunner reusable-VM packing and must not gain a second requirement
  resolver in this focused change.

### TaskRunner reservation data flow

All nine task-start entry points resolve once, persist the task snapshot, and pass
that same object to `startTaskRunnerDO()`:

1. `routes/tasks/submit.ts`
2. `routes/tasks/run.ts`
3. `services/trigger-submit.ts`
4. `durable-objects/sam-session/tools/dispatch-task.ts`
5. `durable-objects/sam-session/tools/retry-subtask.ts`
6. `durable-objects/project-orchestrator/scheduling.ts`
7. `services/session-recovery.ts`
8. `routes/mcp/orchestration-tools.ts`
9. `routes/mcp/dispatch-tool.ts`

`startTaskRunnerDO()` stores it in `TaskRunConfig.resolvedReservation`.
`createAndProvisionWorkspace()` now passes that object directly to
`reserveWorkspacePlacement()`; the workspace-recovery unit test asserts object
identity at this seam, and the D1 race test asserts the serialized workspace value
is byte-for-byte `JSON.stringify()` of the same snapshot. No second resolver exists.

## Required policy

- Provider-native CPU and memory must be known before a node with an existing
  active workspace can be reused. Provider-native disk is enforced when known;
  missing disk capacity also blocks co-tenancy conservatively.
- An empty otherwise-compatible node may accept one workspace even when legacy
  capacity fields are absent. Once occupied, missing/malformed capacity or any
  missing/malformed active reservation blocks further reuse.
- An exclusive request requires an empty node. Any active exclusive reservation
  blocks another request.
- `MAX_WORKSPACES_PER_NODE` remains an optional additional hard cap, not the
  capacity model.
- The final correctness boundary remains one D1 `INSERT ... SELECT`; advisory
  preselection must use the same shared capacity semantics.

## Implementation checklist

- [x] Add a shared reservation/capacity accounting helper with explicit parsing
      and conservative legacy behavior.
- [x] Persist the exact central `resolvedReservation` on the workspace `creating`
      row without re-resolving it.
- [x] Subtract active workspace reservations during reusable-node selection and
      recheck after warm-node claims.
- [x] Extend the final atomic placement CAS to prove aggregate CPU, memory, disk,
      exclusivity, assignment, state, isolation, and the optional count cap.
- [x] Preserve project/user/capacity-pool isolation predicates from PR #1943.
- [x] Document the capacity policy and update `MAX_WORKSPACES_PER_NODE` wording.
- [x] Add a retained process rule requiring aggregate resource invariants to be
      enforced at the final atomic reservation boundary.
- [x] Run lint, typecheck, build, formatting, repository policy checks, the full
      unit suite, and the complete Workers/D1 suite.
- [ ] Run task-completion, Cloudflare, test-engineer, constitution, doc-sync, full
      staging, CodeRabbit, CI, production deploy, and production verification
      gates.

## Local validation evidence

- `pnpm lint`: passed (existing warning-only findings).
- `pnpm typecheck`: passed.
- `pnpm test`: implementation packages passed; the parallel monorepo run produced
  one infra `beforeAll` setup timeout, then `pnpm --dir infra test` passed 68/68 in
  isolation.
- `pnpm build`: 9/9 build tasks passed.
- `pnpm --dir apps/api test:workers`: 65 files and 828 tests passed.
- Focused API reservation, placement, node-selection, and recovery suites passed;
  the split capacity/admission worker suites passed 19/19.
- Format ratchet, file-size, source-contract, migration, Durable Object migration,
  Wrangler binding, AST, runtime-boundary, and type-boundary checks passed.

## Acceptance criteria

- [x] A `cx23` fixture admits one `2000` mCPU / `4096` MB reservation and rejects
      or reselects the second and third even when the count cap is three.
- [x] A larger node admits exactly the aggregate combinations that fit.
- [x] Two concurrent final reservations for the last CPU/memory capacity produce
      exactly one winner.
- [x] Exclusive-node rules hold in selection and the final CAS in both directions.
- [x] Null/malformed legacy reservations fail closed for co-tenancy while an empty
      compatible node still has an explicit single-workspace path.
- [x] Creating and recovery reservations count; stopped and deleted reservations do
      not.
- [x] Capacity placement and resolved reservation snapshots persist unchanged.
- [x] Existing same-user cross-project and project-pool isolation tests remain green.
- [ ] Staging provisions a real small/`cx23`-equivalent node, submits two whole-node
      tasks concurrently, proves the second is not placed on that node, and returns
      all staging VMs to zero.
- [ ] Production deploy is green; new workspace rows contain reservation snapshots;
      no active node exceeds its aggregate declared capacity.

## Post-mortem

- **What broke**: reusable-node selection and the final placement CAS treated a
  workspace as one countable slot instead of a CPU/memory/disk reservation.
- **Root cause**: the audit snapshot and provider capacity were added on separate
  paths, but neither was connected to aggregate accounting at the atomic write.
- **Timeline**: the count-only final CAS landed in August 2026; provider-native
  capacity followed later that month; the September 4 production incident exposed
  the remaining composition gap.
- **Why it was not caught**: race tests proved slot uniqueness and scope isolation,
  while capacity tests proved only that a single request fit a whole node. No test
  combined concurrency with aggregate resource exhaustion.
- **Class of bug**: a concurrency-safe admission check enforced a proxy limit rather
  than the actual aggregate resource invariant.
- **Process fix**: `.claude/rules/69-aggregate-capacity-at-final-reservation.md`
  now requires every reusable-resource
  preselection invariant to be repeated in the final atomic reservation statement,
  with a discriminating last-capacity race test.

## References

- `apps/api/src/services/workspace-placement.ts`
- `apps/api/src/durable-objects/task-runner/node-selection.ts`
- `apps/api/src/durable-objects/task-runner/workspace-steps.ts`
- `apps/api/src/services/placement-resolver.ts`
- `apps/api/tests/workers/vm-admission-control-races.test.ts`
- PR #1876 and PR #1943
