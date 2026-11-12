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

Deviation from the dispatch text, for coordinator sign-off: the dispatch said the package takes node
placement and provisioning through injected interfaces. Because node admission, provisioning and
teardown stay in the worker (above), the package needs no placement or provisioning port; the
worker calls those directly and the package only exports the environment-state constants they use.

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

After step 2 (package): `packages/app-deployment/tests/unit` 12 files / 173 cases (all moved
from apps/api, imports repointed); apps/api keeps 28 of the affected files / 400 cases (399
passed, 1 skipped). 173 + 400 = 573, unchanged from step 1. Worker tests that mocked
`src/db/schema` or spied on `src/lib/logger` now mock `@simple-agent-manager/worker-core/schema`
or `@simple-agent-manager/worker-core` (with `importOriginal`), because package code imports those
directly and the worker paths re-export them.

Review fixes: worker port adapter test (`apps/api/tests/unit/app-deployment-ports.test.ts`, 5
cases), publish-hardening cancel timeout asserted through the settings port, `vm-agent-errors`
schema mock. Affected set after review fixes: package 12 files / 173 cases; apps/api affected files
plus the new adapter test and the two touched route tests all pass (474 passed, 1 skipped across 32
files). Public entry trimmed to values the worker uses (all types exported): 150 names, was 192.

## PR #2605 overlap

#2605 edits `scheduled/compose-image-artifact-cleanup.ts`, `scheduled/deployment-publish-jobs.ts`,
`services/compose-image-artifacts.ts`, `services/deployment-publish-jobs.ts` and their tests,
plus `routes/mcp/compose-publish-tools.ts`, `routes/deployment-release-submission.ts`,
`routes/projects/compose-publish-release-callback.ts`. Those files move here (rename) with only
import-header edits; the sweep's lifecycle call becomes `ports.lifecycle...` (same lines #2605
wraps in `contextShadow`). Whoever lands second rebases those hunks onto the new paths.
#2605's new `scheduled/build-context-cleanup.ts` would be called from the package cleanup and
must then come through a port or move into the package. #2605 also edits `.github/workflows/ci.yml`,
`scripts/quality/direct-dependency-evidence.json`, `apps/www/.../reference/configuration.md`,
`tests/unit/routes/publish-hardening-real-sqlite.test.ts` and
`tests/unit/scheduled/deployment-publish-jobs.test.ts`, which W4 also edits (small, separate hunks
except the two tests).

## Progress

- [x] Step 1: decouple in place under `apps/api/src/app-deployment/` (narrow env, ports, entries, re-exports)
- [x] Step 2: lift into `packages/app-deployment` (prepared on W0's branch; pushed once W0 is on core)
- [x] Docs and comments: path references updated; build order in `guides/local-development.md`
- [x] Move package-only tests into the package
- [x] CI filters (`api`, `cli`), runtime-boundary scan, AST checks scope, catalog entries (`@aws-sdk/*`, `yaml`), dependency evidence
- [x] Local gates (check:fast, runtime-boundary, AST, dependency evidence, runtime-tunables, format ratchet, quality scripts)
- [x] Specialist reviews: security PASS, cloudflare PASS, test-engineer ADDRESSED, architecture ADDRESSED, task-completion PASS
- [x] CI via `gh workflow run ci.yml --ref sam/w4-app-deployment-extract-ngd1ke`: run 43202697278 green on 6f75a77e8
- [x] Merge core branch, publish PR URL + head SHA on channel, notify coordinator (6f75a77e8; coordinator approved content)
- [ ] Merge core 2052fb4b4 (W2 scheduler-core landed): conflicts in ci.yml, env.ts, local-development.md, package.json, ast-checks.ts resolved keeping both sides; no W4 code imports W2-moved files. Local: typecheck clean, package 12 files / 173 cases, apps/api 1063 files passed + 3 skipped / 15751 cases passed + 4 skipped, AST, runtime-boundary, dependency-evidence and node-pool-boundary gates pass. Next: CI on the new head, send SHA + run ID to coordinator, then wait for W5 (ai-proxy) confirmation
