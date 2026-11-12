# W4: extract app deployment into `@simple-agent-manager/app-deployment`

Brief: `tasks/active/2026-11-12-worker-modularization.md` (section W4, "Rules for every
workstream", "How to work"). Coordinator task `01M77BJHHNW5714E98DEEMBCZA`, channel
`feature.worker-modularization`, idea `01M77GBTAM775FAKY72RT4HMDV`.
Branch `sam/w4-app-deployment-extract-ngd1ke`, PR base `sam/help-identify-parts-worker-embcza`
(draft, do not merge, do not mark ready).

## Scope decision

Moves (package): `services/compose-{image-artifacts,publish-apply,renderer}`,
`services/image-resolver{,-outbound}`, `services/deployment-{control,custom-domains,
domain-verify,environment-config,environment-state,environment-summary,publish-job-cancel,
publish-job-defaults,publish-job-settings,publish-jobs,release-events,release-failure,routing,
volumes}`, `scheduled/compose-image-artifact-cleanup`, `scheduled/deployment-publish-jobs`.
About 6K lines.

Stays in the worker (compute-owned, consistent with W2's decision that the CAS reservation
SQL stays in apps/api): `services/deployment-{node-admission,provisioning,
legacy-node-admission,legacy-binding,node-cleanup}`, `scheduled/deployment-{node-cleanup,
stop-recovery}`. They compose node-reservation and node-teardown SQL with
`placement-authority`, `workspace-resource-capacity`, `strict-node-deletion`, `dns`; and
`strict-node-deletion` imports `deployment-legacy-binding`. They import the package's
environment-state constants through its public entry.

Routes stay in the worker (all use session or callback auth middleware).

## Ports (explicit parameters, built in `apps/api/src/app-deployment-ports/`)

| Port                                    | Was                                                    | Used by                             |
| --------------------------------------- | ------------------------------------------------------ | ----------------------------------- |
| `DeploymentProviderPort`                | `provider-credentials` + `lib/secrets`                 | volume create/attach/detach/delete  |
| `DeploymentSecretCipher`                | `services/encryption` + caller-chosen key              | environment config read/write       |
| `DeploymentPublishJobPorts.settings`    | `services/admin-settings`                              | publish-job settings, cancel, sweep |
| `DeploymentPublishJobPorts.vm`          | `routes/mcp/workspace-tools.cancelBuildPublishJobOnVm` | publish-job cancel                  |
| `DeploymentPublishJobPorts.lifecycle`   | `services/project-lifecycle-events`                    | publish-job sweep                   |
| `DeploymentMcpCaller` (structural type) | `services/mcp-token` `McpTokenData` type               | deployment-control                  |

Remaining outside imports are all W0 worker-core modules: `db/schema`, `lib/logger`,
`lib/ulid`, `lib/runtime-validation`, `lib/credential-token-redaction`,
`services/fetch-timeout`, and `lib/route-helpers` (asked W0 to include it; W1 asked too).

Entries: `app-deployment/index.ts` (services) and `app-deployment/scheduled/index.ts`
(sweeps; separate so importing the services does not load the cron modules). Old
`services/*` and `scheduled/*` paths are re-export files, so routes, compute files and
`vi.mock` paths are unchanged.

## Tests

Baseline on `bbb1c82ca` for the 41 test files touching moved modules: 40 unit files, 572
cases (571 passed, 1 skipped); 1 workers file (`deployment-environment-config`), 8 cases.

After step 1: 40 unit files, 573 cases (572 passed, 1 skipped; +1 new case for the admin
cancel timeout), workers file 8 passed. Tests changed for new signatures: publish-job cancel
and sweep tests inject fake ports (they now exercise the real cancel module); volume tests go
through the worker provider port; deploy-release callback test verifies the cipher is bound
to the server key; environment config workers test uses the cipher.

Full apps/api unit suite after step 1: 1087 files (1084 passed, 3 skipped), 16017 cases (16013 passed, 4 skipped).

Coordinator decision (channel): `lib/route-helpers.ts` goes into worker-core, so no port is needed for `parsePositiveInt`.

## PR #2605 overlap

#2605 edits `scheduled/compose-image-artifact-cleanup.ts`, `scheduled/deployment-publish-jobs.ts`,
`services/compose-image-artifacts.ts`, `services/deployment-publish-jobs.ts` and their tests,
plus `routes/mcp/compose-publish-tools.ts`, `routes/deployment-release-submission.ts`,
`routes/projects/compose-publish-release-callback.ts`. Those files move here (rename) with only
import-header edits; the sweep's lifecycle call becomes `ports.lifecycle...` (same lines #2605
wraps in `contextShadow`). Whoever lands second rebases those hunks onto the new paths.
#2605's new `scheduled/build-context-cleanup.ts` would be called from the package cleanup and
must then come through a port or move into the package.

## Progress

- [x] Step 1: decouple in place under `apps/api/src/app-deployment/` (narrow env, ports, entries, re-exports)
- [ ] Step 2: lift into `packages/app-deployment` once W0 is ready (template, worker-core imports)
- [ ] Docs: update path references (`architecture/overview.md:221`, `reference/configuration.md:358`) to the final package path in step 2
- [ ] Move package-only tests into the package
- [ ] Local gates, specialist reviews, CI via `gh workflow run ci.yml --ref sam/w4-app-deployment-extract-ngd1ke`
- [ ] Merge core branch, publish PR URL + head SHA on channel, notify coordinator
