# Fix task runtime liveness heartbeat classifier

## Problem

`classifyTaskRuntimeLiveness` treated a stale node heartbeat as conclusive runtime death for VM workspaces. Under CPU starvation from concurrent devcontainer builds, a healthy VM agent can stop heartbeating for several minutes while the node still has running workspaces. The stuck-task sweep then tears down active work.

## Research findings

- `apps/api/src/services/task-runtime-liveness.ts` is the shared pure classifier used by the cron sweep and ProjectData adapter.
- `apps/api/src/scheduled/stuck-tasks.ts` previously returned immediately when the pure classifier produced `node_not_live`, so no direct VM-agent probe could run.
- Rule 47 requires short, env-configurable control-loop I/O budgets. The node health probe must not inherit the 30s interactive VM-agent timeout.
- Rule 53 applies because heartbeat is a liveness timestamp, not definitive death evidence under SAM-created CPU load.
- Rule 58 applies because destructive terminal verdicts need stronger evidence than a status/timestamp that can diverge from recoverability.
- The 2026-08-25 production stability audit identified this as the first P0 regression: stale D1 node heartbeat + running workspace rows must be exercised with successful, failed, and timed-out node health probes through both liveness runtimes.
- Rule 61 applies because the stale-heartbeat guard is a cross-runtime liveness invariant: cron and ProjectData must call the same service-level probe decision/helper.
- PR #1903 added the write-time supersession TOCTOU fence. This PR must preserve that fence when a stale-heartbeat candidate eventually becomes terminal after a failed node health probe.

## Implementation checklist

- [x] Add task-liveness-specific default probe timeout constant and env field.
- [x] Add node health probe outcome and running-workspace count to classifier signals.
- [x] Keep terminal node status as conclusive death.
- [x] Make stale heartbeat inconclusive unless a short direct VM-agent health probe fails.
- [x] Move node health probe timeout/decision/probe helpers into the shared liveness service.
- [x] Wire the scheduled stuck-task adapter to probe `/health` for stale running VM node signals before terminalizing.
- [x] Wire the ProjectData local adapter to the same service-level probe path as cron.
- [x] Let a successful node probe continue to task-scoped ACP liveness; only a failed probe converts stale node fields to `node_not_live`.
- [x] Preserve timed-out or configuration-error node health probes as inconclusive runtime liveness.
- [x] Add cron sweep regression coverage for stale heartbeat + running workspaces + successful/failed/timeout node health probes.
- [x] Add ProjectData adapter regression coverage for stale heartbeat + running workspaces + successful/failed/timeout node health probes.
- [x] Add explicit regression coverage that a stale-heartbeat `node_not_live` terminal write still keeps the PR #1903 supersession fence.

## Acceptance criteria

- [x] Stale heartbeat with running workspaces returns inconclusive before/without a failed probe.
- [x] Stale heartbeat with running workspaces and a failed direct probe becomes conclusive `node_not_live`.
- [x] Stale heartbeat with running workspaces and a successful direct probe is not enough to prove task liveness by itself; classification continues to task-scoped ACP state.
- [x] Stale heartbeat with running workspaces and a timed-out direct probe remains inconclusive.
- [x] Cron and ProjectData adapters exercise the same stale-heartbeat probe semantics.
- [x] A successor inserted after stale-heartbeat classification but before terminal update prevents the predecessor terminal write.
- [x] Probe timeout defaults to 5 seconds and is env-configurable.

## Validation evidence

- `pnpm --filter @simple-agent-manager/api test -- tests/unit/services/task-runtime-liveness.test.ts tests/unit/stuck-task-slept-session-liveness.test.ts tests/unit/stuck-task-superseded-termination.test.ts tests/unit/stuck-tasks.test.ts` — 4 files, 151 tests passed.
- `pnpm --filter @simple-agent-manager/api test` — 605 files, 8261 tests passed.
- `pnpm --filter @simple-agent-manager/api lint` — passed.
- `pnpm --filter @simple-agent-manager/api typecheck` — passed.
- `pnpm --filter @simple-agent-manager/shared build` — passed.
- `pnpm --filter @simple-agent-manager/api build` — passed.
- `pnpm format:check` — passed.
- `pnpm lint:oxlint` — passed in advisory/shadow mode.
- `pnpm quality:type-boundaries` — passed with 0 blocking findings.
- `pnpm --filter @simple-agent-manager/www typecheck` — passed with existing baseline Astro template findings.
- `pnpm --filter @simple-agent-manager/www build` — passed.
- Pre-PR red proof: a temporary `origin/main` worktree with a minimal stale VM heartbeat + running workspaces classifier test failed as expected because the old classifier returned `conclusive: true`.

## Specialist review evidence

| Reviewer                    | Status | Outcome                                                                                                                                                                                    |
| --------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `cloudflare-specialist`     | PASS   | No Wrangler, binding, migration, KV, or R2 changes. Added VM-agent `/health` calls are per-candidate, bounded by env-configurable timeout, and scoped to stale running VM-node candidates. |
| `constitution-validator`    | PASS   | Probe URL derives from `BASE_DOMAIN`/VM-agent protocol/port configuration; timeout uses `DEFAULT_TASK_LIVENESS_NODE_HEALTH_PROBE_TIMEOUT_MS` with env override.                            |
| `env-validator`             | PASS   | `TASK_LIVENESS_NODE_HEALTH_PROBE_TIMEOUT_MS` is task-specific, optional Worker env; code, `.env.example`, configuration docs, and env reference are synchronized.                          |
| `test-engineer`             | PASS   | Coverage includes pure classifier branches plus vertical cron and ProjectData adapter paths for success, failure, and timeout health-probe outcomes.                                       |
| `task-completion-validator` | PASS   | Research findings, checklist items, and acceptance criteria map to implementation/test diff; no UI or multi-resource propagation path is in scope.                                         |

## Deferred out-of-scope follow-up

- Filed SAM idea `01M0XTVR69PBBKJT5MK6ACGB2J` for the audit's adjacent `workspace_missing` verdict parity gaps so this PR stays focused on stale node heartbeat liveness.

## References

- `apps/api/src/services/task-runtime-liveness.ts`
- `apps/api/src/scheduled/stuck-tasks.ts`
- `apps/api/src/durable-objects/project-data/task-runtime-liveness.ts`
- `packages/shared/src/constants/defaults.ts`
- `.claude/rules/61-one-guard-every-runtime.md`
- `.claude/rules/47-control-loop-io-budget.md`
- `.claude/rules/53-scheduled-handler-isolation-and-liveness-signals.md`
- `.claude/rules/58-terminal-verdicts-must-match-the-resumer.md`
