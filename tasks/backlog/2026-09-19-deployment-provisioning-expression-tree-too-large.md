# Deployment node provisioning fails with `D1_ERROR: Expression tree is too large`

**Status:** resolved in PR #2102 — staging verified on 2026-09-19
**Discovered:** 2026-09-19 on staging, while trying to staging-verify
`tasks/archive/2026-09-19-port-app-deployment-fixes-and-dedupe-pending-release.md`.
Not caused by that change — see "Not the porting branch" below.

## Problem

Every attempt to place a deployment environment on a node fails within ~2 seconds of release
submission:

```
deployment_environments.status            = 'error'
deployment_environments.observed_status   = 'failed'
deployment_environments.observed_error_message =
  "Deployment node placement failed: D1_ERROR: Expression tree is too large (maximum depth 100): SQLITE_ERROR"
```

The message is written by `markDeploymentReleasePlacementFailed`
(`apps/api/src/routes/deployment-release-submission.ts:191-211`), which is the catch around
`provisionDeploymentNode` (`apps/api/src/services/deployment-provisioning.ts:468`). So the D1
error is raised by a query inside that provisioning call.

SQLite's expression-depth ceiling is a **platform limit D1 sets at 100**, well below stock
SQLite. It is therefore invisible to the Durable Object / `better-sqlite3` unit tests, exactly
the harness-ceiling class described in
`apps/api/.claude/rules/69-emergency-config-paths-need-their-own-coverage.md` → "Harness-Ceiling
Divergence".

## Reproduction (staging, 3 for 3)

1. `POST /api/projects/:projectId/environments` with `{ name }` → 201.
2. `POST /api/projects/:projectId/environments/:envId/releases`, `Content-Type: text/yaml`, with
   any valid Compose manifest → 201.
3. `GET /api/projects/:projectId/environments/:envId` within ~3 s → `status: 'error'` with the
   message above.

Observed at 08:45:07Z, 08:49:19Z and 08:53:06Z on 2026-09-19 against project
`01KVRJCC7Y3NSDQYCPWDRPVJVH` on `api.sammy.party`.

The spec that reproduces it is already in the tree:
`apps/web/tests/playwright/staging-app-deployment-path.spec.ts`.

## Resolution

The failing composed statement was `linkEnvironmentToNode`'s
`UPDATE deployment_environments ... WHERE EXISTS (SELECT ... FROM nodes ... ${authority.sql})`.
It nested the full placement-authority predicate under the update's own environment guards,
occupancy subqueries, native identity checks and project-membership checks. The same authority
predicate was also composed once earlier in the advisory `findDeploymentNodeWithCapacity` query.

PR #2102 fixes the D1 expression-depth failure by:

- keeping `findDeploymentNodeWithCapacity` advisory and limited to stable node/native identity
  filters;
- rewriting the final link as `UPDATE deployment_environments AS de ... FROM nodes n ...` with
  the full placement-authority predicate still present on the atomic write;
- adding `apps/api/tests/workers/deployment-provisioning-expression-depth.test.ts`, which runs
  the assembled final-link statement against Workers D1 with a concrete deployment capacity-pool
  snapshot.

Initial local verification:

- `pnpm --filter @simple-agent-manager/api typecheck`
- `pnpm --filter @simple-agent-manager/api exec eslint src/services/deployment-provisioning.ts tests/workers/deployment-provisioning-expression-depth.test.ts`
- `pnpm --filter @simple-agent-manager/api test -- tests/unit/services/deployment-native-placement.test.ts tests/unit/deployment-provisioning.test.ts`
- `pnpm --filter @simple-agent-manager/api exec vitest run --config vitest.workers.config.ts tests/workers/deployment-provisioning-expression-depth.test.ts --reporter verbose --testTimeout 30000`
- `pnpm lint`
- `pnpm typecheck`
- `pnpm build`
- `pnpm test`

Final staging verification on 2026-09-19:

- Deployed PR branch `sam/port-five-app-deployment-eew7ee` commit
  `ce7b27bf2a9928bf1e40f6cf4ec0edd1713ce852` to staging with GitHub Actions
  run `35443637687`; deploy, health check, and smoke tests passed.
- Ran `pnpm --filter @simple-agent-manager/web exec playwright test
  tests/playwright/staging-app-deployment-path.spec.ts --project='Desktop (1280x800)' --reporter=line`.
- The staging release reached `status=active`, `observedStatus=applied`, and
  `observedAppliedSeq=1` for environment `01M2WW3QX4J3CDDKW7R63M2QH0` on node
  `01M2WW3TZ6BSP0TXVAPKTNNZVM`.
- Cleanup deleted environment `01M2WW3QX4J3CDDKW7R63M2QH0`, reported
  `nodeDeleted=true`, `volumesDetached=0`, `volumesDeleted=0`, and removed one DNS record;
  the explicit follow-up `DELETE /api/nodes/01M2WW3TZ6BSP0TXVAPKTNNZVM` returned 404.

Production exposure note: production shares this code path. The recorded production D1 evidence in
this task showed no production deployment-environment placement since 2026-08-26
(`01M100A361P49T716X6QBV2NV5`), so existing production deployments did not disprove the bug. The
fix should deploy before the next production placement; no separate production data mutation was
performed during this PR verification.

## What is and is not implicated

- **Not volume-related.** Reproduced with a named volume (`x-sam-size-hint-mb`) AND with a
  volume-free manifest. Same error, same timing.
- **Not placement resolution.** `resolveDeploymentPlacement` SUCCEEDS — the run that got as far
  as creating a node row left a complete `nodes.placement_explanation_json`
  (`hetzner` / `fsn1` / `cx23`, `effectivePoolState: "configured-ready"`,
  `exhaustionPolicy: "queue"`, `strategy: "balanced"`).
- **Not credentials.** The resolved capacity source is credential
  `01KWRXEJH4RXW2NC5T8WCCQFTV` (hetzner, `credential_type='cloud-provider'`, `is_active=1`) for
  the smoke user, and staging additionally has an enabled platform Hetzner credential
  (`platform_credentials` `01KNY6DC06C9QCYQM0389NAGNT`).
- **Not workspace provisioning.** Workspace-role nodes provisioned normally on staging the same
  hour (`01M2WCH7ANSDPTM2KQE63Y7Q3J` 08:29Z, `01M2WCSXMB4CCR0AWKJB2GGKQ6` 08:33Z) — both reached
  `running`/`healthy` with backend DNS records. The defect is specific to the **deployment**
  provisioning path.
- **Failure point varies between runs**, which is itself a clue: one run created a `nodes` row
  before failing (so it got past `findDeploymentNodeWithCapacity` into `linkEnvironmentToNode`),
  two runs created no row at all (so they failed at or before `findDeploymentNodeWithCapacity`).
  Both of those functions compose `buildPlacementAuthoritySqlPredicate`
  (`apps/api/src/services/placement-authority.ts:75`) into a hand-written SQL string.

## Prime suspects

`linkEnvironmentToNode` (`deployment-provisioning.ts:253-317`) builds an `UPDATE … WHERE …
EXISTS ( SELECT … )` that nests, inside one `WHERE`:

- two further correlated subqueries (`SELECT COUNT(*) …`, `NOT EXISTS ( SELECT 1 … )`),
- `deploymentNativeIdentityPredicate(placement).sql`,
- `buildPlacementAuthoritySqlPredicate(...).sql`.

`findDeploymentNodeWithCapacity` (`:130`) composes the same authority predicate into its own
raw SQL. A first attempt to size the authority predicate in isolation produced only a trivial
9-character fragment, so the depth almost certainly comes from the **composition** — the
authority predicate nested inside the correlated-subquery structure — rather than from the
authority predicate alone. Measure the assembled statement, not the fragment.

## Why this matters beyond staging

This is the production code path. No production deployment environment has been created since
2026-08-26 (`01M100A361P49T716X6QBV2NV5`), so nothing has exercised it — prod's two live
deployment environments predate whatever change introduced the depth regression. **Treat
production as likely affected until proven otherwise**, and do not assume the two long-lived
prod deployment nodes are evidence the path still works: they were placed months ago.

## Not the porting branch

`sam/port-five-app-deployment-eew7ee` (the app-deployment fix port) touches none of the
implicated files. Its full file list contains no `deployment-provisioning.ts`,
`placement-authority.ts`, `placement-resolver*.ts`, or capacity-pool file. Verified with
`git diff origin/main...HEAD --name-only | grep -E 'provisioning|placement|capacity'` → no
matches. The error reproduces on that branch's staging deploy purely because it is the first
thing in months to try creating a deployment environment.

## Acceptance criteria

- [x] The exact failing statement is identified and its assembled expression depth measured
      against D1's limit of 100 (not stock SQLite's). The staging reproduction measured the
      practical D1 ceiling directly: the nested `linkEnvironmentToNode` final-link statement
      failed 3/3 with `Expression tree is too large (maximum depth 100)`, while the flattened
      statement now runs in Workers D1.
- [x] The statement is restructured to stay under the limit without weakening any authority /
      tenancy / node-class predicate — `apps/api/.claude/rules/51-server-side-node-class-gates.md`
      governs that predicate, so the cross-tenant attack tests and owner-path controls it
      requires must still pass. The full `buildPlacementAuthoritySqlPredicate(...)` remains on
      the atomic update statement.
- [x] A regression test executes the real assembled statement against a SQL engine with
      `SQLITE_LIMIT_EXPR_DEPTH` set to 100, or against D1 itself in
      `apps/api/tests/workers/`; a `better-sqlite3` test cannot observe this limit
      (`apps/api/.claude/rules/69`, "Harness-Ceiling Divergence"). Covered by
      `apps/api/tests/workers/deployment-provisioning-expression-depth.test.ts`.
- [x] A staging deployment environment reaches `active` with `observed_applied_seq > 0`.
- [x] Production is checked for the same exposure, and a note recorded either way.
- [x] `apps/web/tests/playwright/staging-app-deployment-path.spec.ts` passes end to end, which
      also unblocks live verification of the six fixes ported on 2026-09-19.

## References

- `apps/api/src/services/deployment-provisioning.ts` (`provisionDeploymentNode`,
  `linkEnvironmentToNode`, `findDeploymentNodeWithCapacity`)
- `apps/api/src/services/placement-authority.ts` (`buildPlacementAuthoritySqlPredicate`)
- `apps/api/src/routes/deployment-release-submission.ts`
  (`markDeploymentReleasePlacementFailed`)
- `apps/api/src/lib/d1-limits.ts` — the existing home for D1 platform limits
  (`D1_MAX_BOUND_PARAMETERS`); an expression-depth constant belongs beside it
- `apps/api/.claude/rules/69-emergency-config-paths-need-their-own-coverage.md` — the
  harness-ceiling class
- `apps/api/.claude/rules/51-server-side-node-class-gates.md` — the predicate that must not be
  weakened
- Blocked task: `tasks/archive/2026-09-19-port-app-deployment-fixes-and-dedupe-pending-release.md`
