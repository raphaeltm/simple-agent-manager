# Build a scheduler lifecycle race lab

**Priority**: High
**Created**: 2026-08-15
**SAM task**: `01M019MMRSQB5P5K5HPCV3KC20`
**Idea**: `01M01CS8PMWKD7AX7Q88V3WWKN`

## Problem

Recent scheduler incidents survived the existing unit and staging checks because the failures
emerged only when independently reasonable control loops observed different lifecycle states. The
production failures included sessions whose first sleep precondition failed and then became
ineligible for retry, provisioning nodes destroyed before their owning task created a workspace,
and activity or ownership signals that were present in one store but absent from another.

Running hundreds of real sessions for days is too slow and expensive for routine development. We
need a credential-free local test lab that compresses virtual time, deliberately interleaves
scheduler actions, and exercises the real Cloudflare persistence boundaries where atomicity matters.
The same tests must run in pull-request CI, with a larger but still local exploration profile on a
schedule.

Staging and production-like soak tests are explicitly out of scope for this task. The pull request
must remain unmerged until Raphaël explicitly authorizes a merge.

## Research Findings

1. `tasks/active/2026-08-14-fix-stranded-session-sleep-cleanup.md` documents a cross-control-plane
   lifecycle failure: completion happened while the ACP prompt was still active, the failed sleep
   state was outside the retry selector, and sessions without snapshot rows never entered the
   sweep. Existing tests asserted local call order or seeded only the happy snapshot state.
2. `tasks/archive/2026-08-07-fix-provisioning-node-cleanup-race.md` documents cleanup destroying a
   newly provisioned task-owned node before its first heartbeat or workspace. The missing states
   were an active task claim and the pre-heartbeat provisioning grace window.
3. The runtime recovery work found the same structural testing gap: isolated stores looked
   correct, while a stale secondary heartbeat could defeat the authoritative recovering owner when
   the three actors were composed.
4. `findNodeWithCapacity()` reads workspace occupancy before `createAndProvisionWorkspace()`
   inserts its `creating` row. Concurrent TaskRunner Durable Objects can therefore observe the same
   final slot unless placement has a durable claim or a final atomic recheck.
5. General node cleanup performs provider deletion before marking the D1 node deleted. The trial
   cleanup path already demonstrates a safer `destroying` claim with a final active-workspace
   predicate, which is a useful production pattern for a Workerd race slice.
6. VM-agent activity reporting reads `SessionHost.config.ProjectID`, while the server session
   factory supplies workspace and session IDs but can omit the workspace runtime's project ID.
   A cross-project contract test should prove that each activity event reaches its owning project.
7. The repository already has `fast-check`, Vitest, real local D1 and Durable Objects through
   `@cloudflare/vitest-pool-workers`, and Go boundary injection. No external infrastructure or
   credentials are required for these layers.
8. Deterministic concurrency testing works best with a virtual clock/event queue, a simple model,
   explicit yield points around persistent/external boundaries, replayable seeds and shrink paths,
   safety checks after every event, and a recovery phase after fault injection stops.
9. Small deterministic scenarios should run on every pull request; many more seeds and longer
   traces can run in a credential-free nightly workflow. Failures must print enough seed, path, and
   trace data to reproduce locally.

## Implementation Checklist

- [x] Add a deterministic virtual-time scheduler lifecycle harness with generated tasks, sessions,
      workspaces, nodes, transient failures, stale observations, and explicit interleavings.
- [x] Check safety invariants after every simulated transition and liveness/convergence invariants
      after faults stop and all due recovery work drains.
- [x] Add historical calibration scenarios proving the oracle rejects the stranded sleep-retry and
      provisioning-cleanup behaviors from the recent production incidents.
- [x] Add a bounded pull-request profile with reproducible seed/path diagnostics.
- [x] Add a deeper credential-free nightly profile that explores more seeds, longer traces, and
      larger small-world state spaces without calling staging or cloud providers.
- [x] Add Workerd vertical slices using real local D1/Durable Objects for cleanup-versus-placement,
      capacity contention, and cross-store session retry/reconciliation races where applicable.
- [x] Fix any scheduler atomicity or ownership defects the discriminating tests expose, preserving
      a regression test for each fix.
- [x] Add a VM-agent contract test for project-scoped activity routing and fix omitted project
      context if reproduced.
- [x] Wire the fast profile into pull-request CI and the deep profile into a scheduled/manual CI
      workflow using pinned actions and no external credentials.
- [x] Run the fast and Workerd suites repeatedly locally, run the deeper profile enough times to
      collect useful evidence, and document which recent incident classes they detect.
- [x] Run full affected-package lint, typecheck, unit, Workers, and Go quality gates.
- [x] Complete task, test, Cloudflare, Go, constitution, and documentation review as applicable.
- [x] Open and maintain a draft PR, push meaningful increments frequently, and do not merge without
      explicit authorization.

## Acceptance Criteria

- Pull-request CI runs a deterministic, credential-free lifecycle simulation in minutes, not hours,
  and failures include a replayable seed/path plus a minimized or bounded trace.
- The harness models multiple projects, tasks, sessions, workspaces, and nodes; asynchronous
  lifecycle actions can be reordered at named persistence and external-I/O boundaries.
- Safety invariants prevent capacity overcommit, destructive cleanup of task-owned or active
  resources, duplicate live ownership, and terminal resources with no bounded cleanup/retry path.
- Once faults stop, every eligible terminal/idle session and unowned resource converges to a safe
  sleeping/deleted state or an explicit bounded retry state.
- Calibration tests fail under policies equivalent to the recent stranded-session and premature
  provisioning-node deletion bugs, demonstrating that the oracle is discriminating.
- Real local D1/Durable Object tests exercise the production claim/CAS paths for the highest-risk
  races instead of relying only on an in-memory imitation.
- A deeper local nightly profile explores materially more schedules than the pull-request profile
  and remains runnable on demand in the same workspace.
- VM-agent activity is routed with the owning workspace's project ID, including concurrent
  workspaces from different projects on one node.
- Repeated local runs are green after fixes and the PR report clearly states which recent incident
  classes were reproduced, which are prevented, and any remaining blind spots.
- No staging or production infrastructure is used, and the PR remains draft/unmerged pending
  explicit authorization.

## Validation Evidence

- Baseline scheduler lifecycle suites: 4 files and 82 tests passed.
- Pull-request simulation profile: 200 generated runs passed after calibration.
- Nightly simulation profile: 2,000 generated runs passed locally.
- Historical calibration tests reject stranded sleep retry, premature provisioning-node cleanup,
  and last-slot capacity TOCTOU policies.
- Real Workerd/D1 race slice: 4 tests passed, with 24 opposite-order repetitions each for atomic
  final-slot placement and cleanup-versus-placement ownership, plus active provisioning claims and
  TaskRunner reselection.
- Before the fix, the new VM-agent cross-project activity test failed as intended: both
  SessionHosts omitted their workspace project and no callback reached the test control plane.
- After binding SessionHosts to `WorkspaceRuntime.ProjectID`, the cross-project activity test passed
  10 consecutive runs. The broader server package reached an unrelated pre-existing Docker-backed
  test that cannot run in this workspace because the Docker CLI is absent.
- An expanded local exploration passed 100,000 generated schedules with up to 200 commands, 40
  task slots, and 8 projects in 8.58 seconds. Its first run exposed the default 5-second Vitest
  ceiling, so the nightly profile now carries an explicit bounded timeout for larger runs.
- Full API validation passed after the review fixes: ESLint, TypeScript typecheck, 540
  unit/integration files with 7,235 tests, and 49 Workerd files with 629 tests. The two complete
  Workerd passes took 831.87 and 829.49 seconds;
  the focused real-D1 race slice remains the inexpensive scheduler-change signal.
- VM-agent validation passed `go vet ./...`, `go build ./...`, and 10 race-detector repetitions of
  `TestSessionHostActivityUsesOwningWorkspaceProject`. A full `go test ./internal/server` run was
  attempted and reached only the existing Docker-dependent `TestBootstrapLifecycle_SessionsUseDetectedUser`
  environment failure (`docker` is not installed); the new routing test passed in that run.
- Repository quality gates passed: formatting, file sizes, source-contract tests, AST checks (zero
  errors; repository warnings only), quality-script tests (32 files, 302 tests), and `git diff --check`.
  The file-size gate initially caught `workspace-steps.ts` at 809 lines, so remote-branch handling
  was extracted into `workspace-branch.ts`; the original module is now 667 lines and its 10 focused
  branch-provider tests pass.
- Specialist review found one high-risk false-success path after the initial validation: scheduled
  cleanup still used the legacy teardown helper, which collects provider/container failures instead
  of throwing. That could mark D1 deleted while an external resource survived. Scheduled cleanup
  now uses strict teardown, strict teardown covers managed Cloudflare containers, and failed teardown
  releases the `destroying` claim to its prior status with `cleanup_backoff_until`. The focused unit
  set passes 152 tests and a real Workerd/D1 slice proves a thrown container teardown leaves the node
  `running` with backoff rather than falsely deleted.
- With explicit approval, the Sonar follow-up hardened the credential-free nightly workflow with
  `pnpm install --ignore-scripts`, decomposed cleanup success/failure handling and simulator safety
  assertions below the cognitive-complexity threshold, and applied the two flagged optional-chain
  simplifications. Focused API typecheck, 42 simulator/cleanup tests, ESLint, file-size checks, and
  all 302 repository quality-script tests pass after the refactor. A third full Workerd run also
  passed all 49 files and 629 tests in 944.82 seconds. Dependency-governance tests pass. The local
  Gitleaks wrapper could not complete because scanner output is withheld by policy, so the refreshed
  PR Secret Scan remains the authoritative verification for this follow-up.

## Review Evidence

| Review | Verdict | Evidence / findings |
| --- | --- | --- |
| Task completion | PASS | All nine research findings map to implemented checklist work; every acceptance criterion has automated or recorded verification. No UI or multi-provider selection surface was added. Existing real session-sleep suites complement the model calibration. |
| Test engineering | PASS | Unsafe historical policies fail calibration; production paths use real D1/TaskRunner DO and HTTP-boundary Go tests; external teardown failure now has both unit and Workerd coverage. Remaining provider/network/long-soak behavior is explicitly documented as out of scope. |
| Cloudflare | PASS after fix | Atomic D1 `INSERT ... SELECT` placement and `destroying` cleanup claims serialize the dangerous ownership transitions. Strict external teardown must succeed before the D1 tombstone; failure releases with bounded backoff. No migration or binding changes. |
| Go | PASS | Workspace runtime project context is copied into each SessionHost without new goroutines or lock ordering. `go vet`, `go build`, and 10 race-detector repetitions pass; the only broader local test limitation is the existing Docker-dependent case. |
| Security | PASS | The nightly workflow retains read-only permissions and SHA-pinned actions while disabling dependency lifecycle scripts. The cleanup refactor preserves parameterized D1 writes, atomic ownership claims, strict teardown, and bounded backoff; no credential, authorization, or new logging surface was introduced. |
| Constitution | PASS | No production URL, timeout, limit, or identifier was hardcoded. Placement capacity retains project/env configuration, cleanup backoff retains existing configuration, and simulation scale/timeout are environment-overridable test controls. |
| Documentation | PASS | The simulator README documents CI profiles, replay, invariants, incident calibration, strict teardown/backoff, and blind spots. No public API, environment variable, schema, or deployment contract changed, so public configuration docs require no update. |

Task-completion validation notes one deliberate limitation rather than a completion gap: the
stranded-session incident is newly proven by a discriminating model calibration and the repository's
existing real session-sleep tests, not by a new end-to-end cloud/container sleep run. This is the
explicit local/CI boundary of the task.

## References

- `tasks/active/2026-08-14-fix-stranded-session-sleep-cleanup.md`
- `tasks/archive/2026-08-07-fix-provisioning-node-cleanup-race.md`
- `.claude/rules/35-vertical-slice-testing.md`
- `.claude/rules/47-control-loop-io-budget.md`
- `.claude/rules/53-scheduled-handler-isolation-and-liveness-signals.md`
- `apps/api/src/durable-objects/task-runner/node-selection.ts`
- `apps/api/src/durable-objects/task-runner/workspace-steps.ts`
- `apps/api/src/scheduled/node-cleanup/shared.ts`
- `apps/api/src/scheduled/trial-expire.ts`
- `apps/api/tests/workers/`
- `packages/vm-agent/internal/server/agent_ws.go`
