# W2: extract scheduler-core (pure placement and capacity decisions)

Brief: `tasks/active/2026-11-12-worker-modularization.md` (section "W2: scheduler-core").
SAM task `01M77GDKCKBZP0432E0K38PBBF`. Coordinator task `01M77BJHHNW5714E98DEEMBCZA`.
Branch `sam/w2-scheduler-core-extract-38pbbf`, draft PR into the core branch
`sam/help-identify-parts-worker-embcza`. Channel `feature.worker-modularization`.

## Boundary decision

The package holds decision code only: functions over values that return values. It
holds **no SQL text** and no D1 row mapping. Anything that builds SQL for a D1
statement stays in the worker, because those fragments compose the final
compare-and-swap reservation and encode schema column names:

| Stays in `apps/api` (SQL / D1 / Env) | Why |
| --- | --- |
| `placement-authority.ts` | builds the final-admission SQL predicate |
| `capacity-placement-snapshot.ts` | D1 column list, placeholders and row values |
| `capacity-pool-precedence.ts` SQL builders | `EXISTS` fragments in the admission statement |
| `workspace-reservation-usage.ts` loader + SQL constants | reads D1 |
| `trustedWorkspaceNodeCapacityColumnsSql` (now in `workspace-admission-sql.ts`) | SQL projection |
| `capacity-pool-placement-settings.ts` resolver | reads D1 |
| `workspace-runtime.ts` `resolveWorkspaceRuntime` | reads D1 credentials |
| `placement-resolver.ts` | orchestrates D1 reads |

Moves to the package (whole files): `capacity-pool-authority`,
`capacity-pool-workload-roles`, `placement-authority-snapshot`,
`placement-capacity-ranking`, `placement-diagnostics`, `placement-field-resolution`,
`placement-resolution-error`, `placement-resolver-capacity`,
`placement-resolver-capacity-reuse`, `placement-resolver-capacity-snapshot`,
`placement-resolver-types`, `placement-rollout`, `placement-strategy`,
`provider-limit-policy`, `provisioning-attempt-limits`, `resource-requirements-input`,
`workspace-admission-policy` (with a narrow `WorkspaceAdmissionEnv`),
`legacy-node-pool-compatibility`.

Moves as the pure half of a split file: `workspace-resource-capacity` (evaluation),
`workspace-reservation-usage` (usage type and parsers), `capacity-pool-precedence`
(scope chain), `capacity-pool-placement-settings` (selection defaults),
`workspace-runtime` (`decideWorkspaceRuntime`), `default-capacity-pool-helpers`
(`timestampVersion`). `placement-resolver-capacity` reads the shared `DefaultCapacityPoolSummary`.

## Plan

- [x] Step 1: decouple in place. Collect the pure code under `apps/api/src/scheduler-core/`
      with an `index.ts` public surface; split mixed files; worker imports go through the index.
- [x] Step 2 (after "W0 ready"): `git mv` that directory to `packages/scheduler-core/src`,
      apply the W0 template, switch imports to `@simple-agent-manager/scheduler-core`,
      move pure tests and the simulation tests into the package.
- [x] Test file and case counts before and after recorded below.
- [ ] Local gates, specialist review, CI (`gh workflow run ci.yml --ref <branch>`).

## Progress log

- 2026-11-12: branch created from core `bbb1c82ca`; boundary decided (above).
- 2026-11-12: Step 1 done. Pure code is in `apps/api/src/scheduler-core/` (no imports
  outside `@simple-agent-manager/shared` and `valibot`); `index.ts` exports the 129 symbols
  the worker and tests use. A codemod rewrote 122 importers. `Env` now extends
  `WorkspaceAdmissionEnv` (the eight `TASK_RUN_NODE_*` admission tunables moved there).
  `trustedWorkspaceNodeCapacityColumnsSql` moved to `services/workspace-admission-sql.ts`;
  `timestampVersion` moved to `scheduler-core`'s `capacity-pool-authority.ts`;
  `placement-resolver-capacity` takes the shared `DefaultCapacityPoolSummary`.
  `tsc` clean, eslint clean on changed files, 31 affected test files / 708 tests pass.
  Next: full suites, then wait for "W0 ready" to lift into `packages/scheduler-core`.
- 2026-11-12: the `node-pool-boundary` quality gate scopes by directory; it now scans the new
  location (scope of all 19 moved files verified identical before and after). The `apps/www`
  placement-catalog test read a moved file by path; fixed with all doc/rule references.
  CI run 43196042731 green except Secret Scan (expired gitleaks baseline inherited from core).
- 2026-11-12: Step 2 done on top of W0 (`2c364fa95`, merged as `54796c3ed`).
  `packages/scheduler-core` follows the W0 template; worker imports use
  `@simple-agent-manager/scheduler-core` (109 files). 7 unit test files and the scheduler
  simulation suite moved into the package; `test:scheduler*` scripts and the nightly
  `scheduler-lifecycle.yml` workflow now target the package. Added to ci.yml path filters,
  the runtime-boundary semantic scan, the node-pool-boundary roots, the build order doc and
  direct-dependency evidence (`fast-check`). The host-memory reserve sync test stays in the
  worker (it cross-checks a cloud-init source file).

## Test counts

| Suite | Core `bbb1c82ca` | After W0 merge (W0's count) | After W2 |
| --- | --- | --- | --- |
| `apps/api` unit/integration/simulation (vitest.config) | 1,084 files / 16,012 tests | 1,077 / 15,924 | 1,068 / 15,803 |
| `packages/scheduler-core` | — | — | 9 / 121 |
| `apps/api` Workers pool (static `it`/`test` count) | 180 files / 1,744 | unchanged | 180 / 1,744 |

W2 moved 9 files / 121 tests from `apps/api` into the package (15,803 + 121 = 15,924); no test
was deleted. The 7 files / 88 tests between core and the W0 column moved into worker-core in W0.
