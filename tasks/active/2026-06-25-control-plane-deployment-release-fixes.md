# Fix Control-Plane Deployment Release Reconcile and Callback Auth

## Problem

Two independent production-confirmed control-plane bugs block deployment recovery and observability:

1. A deployment node that reports `failed-initial` with `appliedSeq=0` causes `reconcileDeploymentReleaseStatuses` to mark every release with `version > 0` as `failed`, including newer releases the node never attempted. The heartbeat pending-release gate then refuses to advertise the poisoned release, making the wedge self-perpetuating.
2. `POST /api/nodes/:id/deployment-release-events` is called by the VM agent with a callback JWT Bearer token, but the route currently sits behind the `/api/nodes` session-auth wildcard because `nodes.ts` omits `/deployment-release-events` from its skip list. This returns 401 and drops deployment apply events.

Staging deployment and live Playwright verification are explicitly skipped for this task by request because production is wedged and these are control-plane reconcile/auth fixes. This must be compensated with strong local Miniflare vertical-slice/capability tests, full quality gates, CI, specialist review, and task-completion validation.

## Research Findings

- Idea `01KW0D88X80999KG8NX9G2AJMM` contains the production D1 evidence and required test matrix.
- `apps/api/src/services/deployment-control.ts` currently handles terminal failure with `gt(version, appliedSeq)`, which is over-broad when `appliedSeq=0`.
- `apps/api/src/routes/node-lifecycle.ts` updates observed deployment state, calls `reconcileDeploymentReleaseStatuses`, then re-reads the latest release for pending-release advertisement in the same heartbeat. This ordering means a same-heartbeat publish can be poisoned before the gate evaluates it.
- `apps/api/src/routes/node-lifecycle.ts` contains the `deployment-release-events` handler and already calls `verifyNodeCallbackAuth`.
- `apps/api/src/routes/nodes.ts` has a session-auth wildcard mounted before `nodeLifecycleRoutes`; missing callback paths here produce callback-JWT 401s.
- `apps/api/src/index.ts` already mounts `deployReleaseCallbackRoute` before `nodesRoutes`; mirror that pattern for deployment release events.
- `.claude/rules/34-vm-agent-callback-auth.md` says VM agent callback JWT routes must be extracted and mounted before session-auth routers.
- Existing relevant tests:
  - `apps/api/tests/unit/services/deployment-control.test.ts`
  - `apps/api/tests/unit/routes/node-lifecycle-deployment-heartbeat.test.ts`
  - `apps/api/tests/unit/routes/deploy-release-route-order.test.ts`
  - `apps/api/tests/unit/routes/deploy-release-callback.test.ts`
  - `apps/api/tests/workers/*` for Miniflare/Workers integration patterns
- Relevant rules read:
  - `.claude/rules/02-quality-gates.md`
  - `.claude/rules/10-e2e-verification.md`
  - `.claude/rules/14-do-workflow-persistence.md`
  - `.claude/rules/34-vm-agent-callback-auth.md`
  - `.claude/rules/35-vertical-slice-testing.md`

## Implementation Checklist

- [x] Move this task to `tasks/active/` in the feature worktree.
- [x] Fix `reconcileDeploymentReleaseStatuses` so terminal failure only marks the specific release sequence the node actually reported as failed, not every release newer than `appliedSeq`.
- [x] Preserve recovery behavior: a node in `failed-initial` with `appliedSeq=0` must be advertised a newer `created` release.
- [x] Add regression coverage proving a reported failed seq 1 does not poison seq 2, and seq 2 is advertised by the heartbeat gate.
- [x] Add coverage proving only the reported failed release is marked failed.
- [x] Extract `deployment-release-events` into a dedicated callback-JWT route file mounted before `nodesRoutes` in `apps/api/src/index.ts`.
- [x] Remove the extracted handler from `node-lifecycle.ts` or otherwise ensure the callback route is not dependent on session-auth wildcard allowlists.
- [x] Add positive and negative callback auth coverage for `POST /api/nodes/:id/deployment-release-events`.
- [x] Add or update route-order coverage to catch future callback routes mounted after session-auth node routes.
- [x] Add Miniflare vertical-slice/capability tests for both fixes using realistic D1 state.
- [x] Update `.claude/rules/34-vm-agent-callback-auth.md` reference table for the extracted route and strengthen it against allowlist-based regressions.
- [x] Add a process-rule improvement for over-broad reconcile/sweep mutations.
- [x] Add rule-02 post-mortem sections to this task before archiving.
- [ ] Run full quality gates: lint, typecheck, tests, build, and CI.
- [ ] Run specialist review: cloudflare-specialist, security-auditor, task-completion-validator, plus test-engineer/constitution-validator as applicable.
- [ ] Archive this task only after task-completion-validator passes.
- [ ] Create PR with explicit staging-skip justification, review evidence, test evidence, and post-mortem.
- [ ] Merge only after CI and all required non-staging gates are green.

## Rule 02 Post-Mortem

### Bug 1: failed-initial release poisoning

- **What broke**: A node reporting `failed-initial` with `appliedSeq=0` caused `reconcileDeploymentReleaseStatuses` to mark every release with `version > 0` as `failed`, including newly published releases the node had not attempted.
- **Root cause**: The reconcile query treated terminal node status as a broad sweep over all releases newer than `appliedSeq` instead of scoping the write to the single release implied by the node's observed state. `git log -S reconcileDeploymentReleaseStatuses` traces the code path to `703b8b56 Add app deployment control surface and policy gate (#1356)`.
- **Timeline**: Production D1 evidence in `sam-prod` confirmed the wedge on 2026-06-25. The task was created and fixed the same day on branch `sam/fix-two-independent-control-01kw0d`.
- **Why existing gates missed it**: Tests covered the reconcile helper in isolation but did not assert the heartbeat ordering where reconcile runs before pending-release advertisement, and there was no vertical-slice D1 test for a node recovering from `failed-initial`.
- **Bug class**: Reporter-scoped reconciliation failure. A control-plane reconcile loop mutated rows that were newer than the reporter's concrete evidence.
- **Process fix**: `.claude/rules/02-quality-gates.md` now requires reporter-scoped reconciliation tests for broad update/delete/status-sweep code. Reconcile logic must prove it cannot mutate records that were not explicitly observed, listed, or derivable from the reporter payload.

### Bug 2: deployment-release-events callback 401

- **What broke**: The VM agent posts `POST /api/nodes/:id/deployment-release-events` with a node callback JWT, but the handler lived behind the `/api/nodes` session-auth wildcard. Because the wildcard allowlist omitted `/deployment-release-events`, valid agent callbacks received 401 before reaching callback JWT verification.
- **Root cause**: A new VM-agent callback endpoint was added under the session-auth node route tree instead of being extracted as a dedicated callback-JWT route mounted before session-auth routers. `git log -S deployment-release-events` traces the route introduction to `082e9b71 Async compose publish jobs with polling (#1406)`.
- **Timeline**: Production D1 evidence in `sam-prod` confirmed missing release event callbacks on 2026-06-25. This is the fifth recurrence of the rule-34 callback-auth class.
- **Why existing gates missed it**: Existing route-order coverage protected the deploy-release callback route but did not enumerate every callback-JWT endpoint, and the rule-34 table did not yet include deployment release events.
- **Bug class**: Callback JWT route hidden behind browser session middleware.
- **Process fix**: `.claude/rules/34-vm-agent-callback-auth.md` now lists `deployment-release-events` as an extracted callback route, documents `/api/nodes` callback mounting order, and explicitly forbids fixing new callback routes by extending wildcard allowlists.

## Acceptance Criteria

- A node reporting terminal failure for release seq 1 cannot mark seq 2 failed when `appliedSeq=0`.
- A deployment node in `failed-initial` can receive a newer pending release in the heartbeat response.
- The heartbeat reconcile/gate ordering no longer poisons a same-heartbeat published release.
- Deployment release events posted with a valid node callback JWT return success and persist an event.
- Deployment release events without a valid callback JWT are rejected.
- The VM-agent callback route is mounted before session-auth node routes and documented in rule 34.
- Miniflare vertical-slice/capability tests prove both bug fixes end-to-end against realistic D1 state.
- PR includes post-mortem and process fixes for both bug classes.
- Staging deploy/live Playwright verification is skipped only under the explicit exception and documented in the PR.

## References

- Idea: `01KW0D88X80999KG8NX9G2AJMM`
- `apps/api/src/services/deployment-control.ts`
- `apps/api/src/routes/node-lifecycle.ts`
- `apps/api/src/routes/nodes.ts`
- `apps/api/src/index.ts`
- `packages/vm-agent/internal/deploy/events.go`
- `packages/vm-agent/internal/server/health.go`
- `.claude/rules/34-vm-agent-callback-auth.md`
- `.claude/rules/02-quality-gates.md`
- `.claude/rules/10-e2e-verification.md`
- `.claude/rules/35-vertical-slice-testing.md`
