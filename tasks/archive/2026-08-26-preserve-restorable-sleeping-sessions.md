# Preserve Restorable Sleeping Sessions During Teardown

## Problem

PR #1917 centralized workspace lifecycle finalization, but the finalizer now stops the
ProjectData chat session whenever a terminal workspace/node path still has
`workspaces.chat_session_id` set. It does not check `session_snapshots`, so a clean VM sleep is
archived roughly when NodeLifecycle's staged workspace deletion or node-cleanup later tears down
the old runtime. Once ProjectData marks the chat session `stopped`, VM snapshot recovery can still
claim the D1 snapshot but fails the ProjectData wake commit because `wakeSession()` excludes
`stopped`.

## Post-mortem

### What broke

Freshly-slept VM chat sessions were archived by unrelated runtime teardown. Users lost the normal
in-place wake path after about five minutes unless the follow-up wake raced ahead of teardown.

### Root cause

`finalizeProjectDataSession()` in
`apps/api/src/services/workspace-lifecycle-finalizer.ts` treated any workspace row with a
`chat_session_id` as archive/stop intent. It did not read the snapshot row that
`claimSessionSnapshotRecovery()` reads to authorize a wake.

### Timeline

- 2026-08-26 09:12Z: PR #1917 commit `46289f2a1` deployed.
- 2026-08-26 20:11:46Z: session `90ac3dd3-9fec-432f-8795-bf4e903c239a` slept cleanly with an
  unexpired available/sleeping snapshot.
- 2026-08-26 20:16:20Z: node-cleanup archived that session while destroying its max-lifetime node.
- 2026-08-26 20:56:54Z: session `c6a93f86-628e-4e9f-9166-3da47ade5bf4` slept cleanly.
- 2026-08-26 21:01:19Z: NodeLifecycle staged deletion archived that session.

### Why it was not caught

Tests covered shared finalizer routing and prior liveness classification, but not the real teardown
writers whose finalizer side effect mutates ProjectData. Mock-heavy cleanup tests did not evaluate
the `session_snapshots` SQL predicate or assert ProjectData chat-session state.

### Class of bug

Destroyer/resumer predicate divergence across lifecycle mirrors: a teardown writer made a terminal
ProjectData decision without reading the durable recovery artifact that the resumer uses.

### Process fix

Add a rule/checklist update requiring lifecycle finalizers that stop or archive user-visible work
to mirror the resumer's recovery-artifact predicate, plus regression tests through the real writer
paths that caused the incident.

## Research Findings

- `apps/api/src/services/workspace-lifecycle-finalizer.ts`
  - `finalizeProjectDataSession()` currently calls `projectDataService.stopSession()` whenever
    `stopProjectSessions !== false`, `project_id` exists, and `chat_session_id` exists.
  - The finalizer is the correct choke point because every workspace/node terminal writer is
    expected to route through it.
- `apps/api/src/services/session-snapshot-recovery-lifecycle.ts`
  - `claimSessionSnapshotRecovery()` authorizes VM wake from `session_snapshots` using the
    restorable status/degradation predicate, `sleeping_at IS NOT NULL`, expiry, attempts, recovery
    status, user, and optional source-task guard.
- `apps/api/src/services/session-snapshot-sleep-lifecycle.ts`
  - A successful sleep sets `sleeping_at`, `sleep_status='sleeping'`, resets recovery state, and
    extends `expires_at`.
- `apps/api/src/durable-objects/project-data/sessions.ts`
  - `wakeSession()` accepts `sleeping`, or `active`/`failed` on the same workspace. It rejects
    `stopped`, which bricks sessions that were archived while their snapshot remains restorable.
- `apps/api/src/durable-objects/node-lifecycle.ts`
  - `deleteWorkspace()` is the staged +TTL writer that updates slept/stopped workspaces to
    `deleted` and then calls the shared finalizer.
- `apps/api/src/scheduled/node-cleanup/shared.ts`
  - `destroyNodeForCleanup()` is the max-lifetime/warm/stopped-node writer that deletes node
    resources, marks the node deleted, and then calls the finalizer by node id.
- `apps/api/src/services/workspace-cleanup.ts`
  - User/API workspace delete calls `deleteSessionSnapshotState()` before finalization. This is the
    rule-66 discriminator: genuine archive/delete intent destroys the snapshot row first.
- `apps/api/src/services/task-terminal-cleanup.ts`
  - Destructive terminal cleanup also deletes snapshot state before direct ProjectData stop/fail.
    Non-destructive completed cleanup queues sleep instead of stopping the session.
- Existing tests:
  - `apps/api/tests/unit/stuck-task-slept-session-liveness.test.ts` already covers liveness
    classifier/resumer parity against a real SQL engine.
  - `apps/api/tests/workers/node-lifecycle-do.test.ts` already exercises NodeLifecycle staged
    deletion against real Miniflare D1/DO storage.
  - `apps/api/tests/unit/node-cleanup.test.ts` uses heavy D1 mocks, so incident coverage for
    `destroyNodeForCleanup()` should use a new real-SQL test rather than extending that mock suite.

## finalizeWorkspaceLifecycleClosure Caller Inventory

Guard should apply whenever finalizer is called with `stopProjectSessions !== false` and the
workspace row still carries a restorable sleeping chat session. It should not suppress genuine
archives because those paths delete snapshot state first.

| Caller                                                                   | Runtime/path                           | Guard applies?                                                | Notes                                                                                                |
| ------------------------------------------------------------------------ | -------------------------------------- | ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `services/task-runner.ts:cleanupTaskRun`                                 | VM task cleanup                        | Yes                                                           | Completed task sleep should be preserved if teardown races the sleeping snapshot.                    |
| `durable-objects/task-runner/state-machine.ts`                           | TaskRunner failure cleanup             | Yes, unless failed/error                                      | Failed/error sessions still call `failSession`; no preservation for terminal failure.                |
| `scheduled/node-cleanup/shared.ts:destroyNodeForCleanup`                 | Max-lifetime/warm/stopped node destroy | Yes                                                           | One of the confirmed incident writers.                                                               |
| `scheduled/node-cleanup/workspace-phases.ts:sweepOrphanedWorkspaces`     | Orphan workspace stop                  | Yes for stop status                                           | Restorable sleep should not become archive; non-restorable orphan still stops.                       |
| `scheduled/node-cleanup/workspace-phases.ts:sweepStaleStoppedWorkspaces` | Stale stopped workspace delete         | Yes                                                           | Stale non-restorable sessions still stop.                                                            |
| `durable-objects/node-lifecycle.ts:deleteWorkspace`                      | Staged workspace deletion              | Yes                                                           | One of the confirmed incident writers.                                                               |
| `routes/workspaces/lifecycle.ts`                                         | Explicit workspace stop                | Guard does not preserve                                       | Deletes snapshot state before finalizer, so explicit stop remains destructive/archive intent.        |
| `services/workspace-cleanup.ts:cleanupWorkspaceForDeletion`              | User/API workspace delete/archive      | Guard does not preserve                                       | Deletes snapshot state before finalizer, so no restorable row remains.                               |
| `services/nodes.ts:stopNodeResources`                                    | Node stop/delete cascade               | Yes                                                           | Preserve if this is runtime teardown after sleep; genuine user archive has no snapshot.              |
| `services/nodes.ts:deleteNodeResources`                                  | Node delete cascade                    | Yes                                                           | Same finalizer choke point.                                                                          |
| `services/nodes.ts:retireDeletedDeploymentNodeRecord`                    | Deployment node retirement             | Mostly N/A                                                    | Deployment nodes should not own user chat sessions, but guard is harmless if a workspace row exists. |
| `services/instant-session.ts`                                            | cf-container launch failure            | No preservation for failure                                   | Uses failed status/error; should still fail ProjectData.                                             |
| `durable-objects/vm-agent-container-runtime.ts:persistRuntimeEnded`      | cf-container runtime ended             | Stopped: yes if a restorable row exists; error: no            | The finalizer guard runs for `stopped`; `error` intentionally records failed runtime outcome.         |
| `scheduled/trial-expire.ts`                                              | Anonymous trial expiry                 | Yes only if restorable row exists                             | Trial expiry normally deletes old anonymous resources; no snapshot row means unchanged stop.         |

## Implementation Checklist

- [x] Add a shared D1 predicate/helper for restorable sleeping snapshots, with comments naming
      `claimSessionSnapshotRecovery()`.
- [x] Call that predicate from `finalizeProjectDataSession()` before `stopSession()` and skip the
      ProjectData stop when the snapshot is restorable/unexpired.
- [x] Treat snapshot-lookup failure as "do not stop" and log/count an error rather than performing
      the destructive ProjectData transition.
- [x] Preserve `failSession()` behavior for failed/error lifecycle closures.
- [x] Add a recovery-wake path that can wake a ProjectData `stopped` session only when the D1
      session-snapshot claim authorizes that recovery task.
- [x] Add real-SQL finalizer tests for no snapshot, expired snapshot, restorable snapshot, and
      failed/error closures.
- [x] Add an incident reproduction test through `destroyNodeForCleanup()` using a real SQL D1
      adapter.
- [x] Add an incident reproduction test through NodeLifecycle staged deletion using the workers
      DO/D1 test harness.
- [x] Add controls proving user archive and task-terminal destructive cleanup still stop.
- [x] Verify at least one new incident reproduction test fails on the pre-fix code, then passes.
- [x] Update `.claude/rules/58-terminal-verdicts-must-match-the-resumer.md` with the process fix.
- [x] Run targeted tests and full validation.
- [x] Run required specialist review and address findings.
- [x] Coordinate the staging lane with the unfiltered `gh run list` command before deploying.
- [x] Open PR, get CI green, and complete staging verification.
- [ ] Merge, monitor production deploy, then verify a fresh production sleep
      survives its teardown window.

## Acceptance Criteria

- Sleeping chat sessions with an unexpired restorable snapshot are not archived by workspace/node
  teardown finalization.
- Sessions without a snapshot row, with an expired/non-restorable snapshot, or with destructive
  user/task-terminal cleanup still stop/archive.
- Recovery wake no longer hard-fails solely because ProjectData status is `stopped` when an
  authorized restorable snapshot claim exists.
- Both confirmed teardown writers (`destroyNodeForCleanup()` and NodeLifecycle staged deletion) are
  covered by tests that exercise the real writer path.
- SQL predicates are evaluated against a real SQLite/D1-compatible engine.
- The PR documents every finalizer caller and whether the guard applies.
- CI, staging verification, merge, production deploy monitoring, and production post-deploy sleep
  survival verification are completed.

## Validation Evidence

- Pre-fix verification:
  - `pnpm --filter @simple-agent-manager/api exec vitest run tests/unit/services/workspace-lifecycle-finalizer.test.ts`
    failed because the direct finalizer and `destroyNodeForCleanup()` still stopped a restorable slept
    session.
  - `pnpm --filter @simple-agent-manager/api exec vitest run --config vitest.workers.config.ts tests/workers/node-lifecycle-do.test.ts --testNamePattern "preserves a ProjectData sleeping session"`
    failed because NodeLifecycle staged deletion changed the ProjectData session from `sleeping` to
    `stopped`.
- Targeted post-fix tests:
  - `pnpm --filter @simple-agent-manager/api exec vitest run tests/unit/services/workspace-lifecycle-finalizer.test.ts`
  - `pnpm --filter @simple-agent-manager/api exec vitest run tests/unit/services/project-data-snapshot-recovery-wake.test.ts tests/unit/durable-objects/project-data-sessions-wake.test.ts`
  - `pnpm --filter @simple-agent-manager/api exec vitest run --config vitest.workers.config.ts tests/workers/node-lifecycle-do.test.ts --testNamePattern "preserves a ProjectData sleeping session"`
  - `pnpm --filter @simple-agent-manager/api exec vitest run tests/unit/services/workspace-lifecycle-finalizer.test.ts tests/unit/services/project-data-snapshot-recovery-wake.test.ts tests/unit/durable-objects/project-data-sessions-wake.test.ts tests/unit/stuck-task-slept-session-liveness.test.ts tests/unit/node-cleanup.test.ts tests/unit/stuck-task-terminal-cleanup.test.ts`
  - `pnpm --filter @simple-agent-manager/api exec vitest run --config vitest.workers.config.ts tests/workers/node-lifecycle-do.test.ts`
  - `pnpm --filter @simple-agent-manager/api exec vitest run --config vitest.workers.config.ts tests/workers/project-data-service.test.ts --testNamePattern "wakes a stopped ProjectData session"`
  - `pnpm --filter @simple-agent-manager/api exec vitest run tests/unit/durable-objects/task-runner-agent-session.test.ts`
- Reviewer-driven follow-up tests:
  - `pnpm --filter @simple-agent-manager/api exec vitest run tests/unit/services/workspace-lifecycle-finalizer.test.ts`
    — 16 tests, including degraded-restorable preservation plus non-restorable/cross-scope stops.
  - `pnpm --filter @simple-agent-manager/api exec vitest run tests/unit/services/project-data-snapshot-recovery-wake.test.ts tests/unit/services/workspace-lifecycle-finalizer.test.ts`
    — 23 tests after adding fail-closed recovery-claim coverage and degraded-restorable preservation.
  - `pnpm --filter @simple-agent-manager/api exec vitest run --config vitest.workers.config.ts tests/workers/project-data-service.test.ts --testNamePattern "does not wake a sleeping ProjectData session|wakes a stopped ProjectData session"`
    — 5 tests proving authorized stopped-session wake and unauthorized sleeping-session non-mutation.
  - `pnpm --filter @simple-agent-manager/api exec vitest run --config vitest.workers.config.ts tests/workers/project-data-service.test.ts`
    — 60 tests.
- Full validation:
  - `pnpm lint`
  - `pnpm typecheck`
  - `pnpm build`
  - `pnpm test` — 617 files, 8387 tests.
  - `pnpm --filter @simple-agent-manager/api test:workers` — 58 files, 755 tests.
- Remote pre-staging gates:
  - PR #1937 opened: <https://github.com/raphaeltm/simple-agent-manager/pull/1937>
  - Manual CI workflow run `33023783692` passed on branch
    `sam/fix-production-regression-shipped-nr49ps`.
  - Manual CodSpeed workflow run `33023798244` passed on the same branch.
  - Automatic PR checks did not enqueue for the app-authored PR/synchronize event; E2E Smoke has
    no `workflow_dispatch` trigger, so the staging deploy smoke suite supplied the live smoke
    signal.
- Staging verification:
  - Required unfiltered lane check before deploy:
    `gh run list --workflow=deploy-staging.yml --limit=3 --json databaseId,status,conclusion,createdAt,headBranch`
    returned only completed/successful runs.
  - Deploy Staging workflow run `33024441560` passed, including 12/12 smoke tests.
  - Local authenticated Playwright browser check against `https://app.sammy.party` and
    `https://api.sammy.party` passed: health `200`, token-login `200`, dashboard/projects/settings/
    API tokens loaded, and zero browser console/page/request errors.
  - Feature-specific staging proof used the real staging API and D1 state:
    `POST /api/workspaces/01M0Z49GAZ6ECHST64XSP4M71Y/sleep` at
    `2026-08-27T00:06:49Z` returned `status=sleeping`, chat session
    `736eed0e-67f1-4eed-be10-f53a3fa7a43b`, and snapshot expiry
    `2026-09-03T00:07:00.810Z`.
  - After the +5 minute teardown window, D1 showed the workspace was deleted at
    `2026-08-27T00:12:08.746Z` while the snapshot remained `available`/`sleeping` and unexpired.
    The ProjectData API still reported chat session
    `736eed0e-67f1-4eed-be10-f53a3fa7a43b` as `sleeping`.

## Task Completion Validation

- 2026-08-26 pre-review verdict: WARN.
- Covered: implementation checklist items, required real-writer teardown tests, real-SQL predicates,
  stopped-session recovery unbrick, no-snapshot/expired-snapshot/degraded-restorable/
  non-restorable/cross-scope/user-archive/task-terminal controls, replacement-workspace-gated
  recovery wake authorization, and finalizer caller inventory.
- Pending by design: merge, production deploy monitoring, and production post-deploy sleep survival
  verification.

## Specialist Review Evidence

- `cloudflare-specialist`: PASS. D1 predicates, DO RPC compatibility, and worker coverage are sound.
  Non-blocking recovery-claim predicate hardening was implemented.
- `test-engineer`: PASS after fixes. Added degraded-restorable positive preservation coverage and
  direct real-SQL finalizer discriminator cases.
- `constitution-validator`: PASS. No Principle XI hardcoded-value violations.
- `security-auditor`: PASS after fixes. Unauthorized recovery claims now return before ProjectData
  RPC, and stopped-session wake is gated by the replacement workspace recorded in D1.
- `doc-sync-validator`: PASS after fixes. Rule 58 and caller inventory now match implementation.
- `task-completion-validator`: PASS for implementation/test completeness. Rollout gates remain
  pending by design.

## References

- `.claude/rules/02-quality-gates.md`
- `.claude/rules/28-credential-resolution-fallback-tests.md`
- `.claude/rules/44-dual-write-migration-enumerate-writers.md`
- `.claude/rules/58-terminal-verdicts-must-match-the-resumer.md`
- `.claude/rules/61-guards-must-cover-every-runtime.md`
- `.claude/rules/62-tests-must-observe-the-real-trigger.md`
- `.claude/rules/66-ownership-handoff-must-record-the-supersession.md`
