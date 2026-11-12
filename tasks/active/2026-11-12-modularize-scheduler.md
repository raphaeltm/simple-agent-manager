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
| `workspace-resource-capacity.ts` `trustedWorkspaceNodeCapacityColumnsSql` | SQL projection |
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
(`timestampVersion`), `default-capacity-pool-types` (`CapacityPoolSummary`).

## Plan

- [x] Step 1: decouple in place. Collect the pure code under `apps/api/src/scheduler-core/`
      with an `index.ts` public surface; split mixed files; worker imports go through the index.
- [ ] Step 2 (after "W0 ready"): `git mv` that directory to `packages/scheduler-core/src`,
      apply the W0 template, switch imports to `@simple-agent-manager/scheduler-core`,
      move pure tests and the simulation tests into the package.
- [ ] Test file and case counts before and after recorded below.
- [ ] Local gates, specialist review, CI (`gh workflow run ci.yml --ref <branch>`).

## Progress log

- 2026-11-12: branch created from core `bbb1c82ca`; boundary decided (above).
- 2026-11-12: Step 1 done. Pure code is in `apps/api/src/scheduler-core/` (no imports
  outside `@simple-agent-manager/shared` and `valibot`); `index.ts` exports the 129 symbols
  the worker and tests use. A codemod rewrote 122 importers. `Env` now extends
  `WorkspaceAdmissionEnv` (the eight `TASK_RUN_NODE_*` admission tunables moved there).
  `trustedWorkspaceNodeCapacityColumnsSql` moved to `services/workspace-admission-sql.ts`;
  `timestampVersion` moved to `scheduler-core/capacity-pool-authority.ts`;
  `placement-resolver-capacity` takes the shared `DefaultCapacityPoolSummary`.
  `tsc` clean, eslint clean on changed files, 31 affected test files / 708 tests pass.
  Next: full suites, then wait for "W0 ready" to lift into `packages/scheduler-core`.
