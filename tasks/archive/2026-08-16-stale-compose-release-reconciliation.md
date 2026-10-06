# Reconcile stale compose deployment releases

## Problem

R2 compose image archives under `compose-image-artifacts/` remain protected as long as any
persisted `deployment_releases.manifest` references them. The existing scheduled pipeline
correctly deletes only old unreferenced archives: release retention runs first, then
`runComposeImageArtifactCleanup()` recomputes references and deletes old unreferenced objects.

Production investigation on 2026-08-16 found stale `deployment_releases.status = 'applying'`
rows from 2026-06-26/27 that still reference 9 compose archives / 5.903 GB. Current release
retention intentionally fails closed for every non-terminal status, so those rows are never
pruned and their R2 archives never become unreferenced.

This task must add a bounded, configurable reconciliation step that transitions only provably
stale non-terminal compose releases to a terminal state. Active deploys, observed-applied
releases, newest rollback releases, and ambiguous/future statuses must remain protected.

## Research findings

- `apps/api/src/scheduled/d1-retention.ts:runDeploymentReleaseRetention()` deletes only
  terminal `applied`/`failed` release rows outside the newest-N window and not matching
  `deployment_environments.observed_applied_seq`.
- `apps/api/src/scheduled/compose-image-artifact-cleanup.ts:runComposeImageArtifactCleanup()`
  scans surviving release manifests for `compose-image-artifacts/` references and fails closed
  on malformed relevant manifests.
- `apps/api/src/routes/deploy-release-callback.ts` marks a release `applying` when a deployment
  node fetches a signed apply payload. The row has no status timestamp today, so status age is
  not independently tracked.
- `apps/api/src/routes/node-lifecycle.ts` receives authenticated deployment-node heartbeats,
  persists `observed_applied_seq`, `observed_status`, `observed_at`, and only asks a node to
  apply the latest release when the latest row is `created`, or when it is `applying` but the
  node is not currently reporting `applying`.
- `apps/api/src/services/deployment-control.ts:reconcileDeploymentReleaseStatuses()` maps
  observed runtime status back to release rows: observed `applied` marks the observed seq
  `applied`; observed terminal failure marks the failed seq `failed`; observed `applying`
  is an active-deploy signal.
- `packages/vm-agent/internal/deploy/engine.go` reports `applying`, then either `applied`,
  `failed`, `failed-initial`, or `reverted`. `packages/vm-agent/internal/server/health.go`
  also has an apply watchdog and emits release events during fetch/apply progress.
- `deployment_release_events` provide a cheap D1-only activity/lease signal for apply progress.
  A stale reconciler can protect any release with recent events without calling the node.
- The retained post-mortem in `tasks/archive/2026-08-07-fix-provisioning-node-cleanup-race.md`
  shows cleanup jobs must model the real ownership/state-machine interleaving, not just
  downstream idle state. This task needs deterministic D1 tests for fresh, active, stale,
  concurrent, and ambiguous release states.
- `.claude/rules/47-control-loop-io-budget.md` requires bounded candidate sets and an escape
  path for every selected candidate. The reconciliation must be D1-only, batch-limited, and
  idempotent.
- `apps/www/src/content/blog/sams-journal-the-cleanup-job-asked-d1-first.md` documents the
  core safety rule: R2 artifact cleanup must treat D1 release references as the source of truth,
  never object age alone.
- The separate degraded sleeping session snapshot purge gap is intentionally out of scope for
  this PR unless a tiny shared lifecycle abstraction becomes clearly safer.

## Implementation checklist

- [x] Add additive D1 schema/migration support for release status timestamps needed to make
      stale-state reconciliation race-safe.
- [x] Update release creation/apply/status-transition paths to maintain status timestamp data
      and avoid late apply-fetch overwriting a reconciled terminal status.
- [x] Add configurable stale non-terminal release reconciliation to the scheduled release
      retention path, with safe defaults, kill switch, batch bound, observed-state gate, recent
      event lease, compose-artifact scope, and fail-closed handling for unknown statuses.
- [x] Preserve observed-applied release and newest rollback protection by keeping terminalized
      stale rows subject to the existing terminal release-retention query.
- [x] Ensure the scheduled ordering is reconciliation → terminal release retention → compose
      artifact cleanup so a single scheduled run can make stale old releases unreferenced before
      R2 cleanup.
- [x] Add deterministic tests for fresh applying protection, stale reconciliation, observed
      applied protection, cleanup ordering, batching/concurrency/idempotency, disabled/configured
      behavior, and malformed/future statuses.
- [x] Update `Env`, `.env.example`, generated deployment variable allowlists, env reference, and
      public configuration/architecture docs for the new knobs and stale definition.
- [x] Capture the degraded sleeping snapshot purge gap as a SAM Idea unless addressed in this PR
      by a clearly shared lifecycle abstraction.
- [x] Run focused tests while implementing, then full local validation required by `/do`.
- [x] Run required specialist reviews: Cloudflare, constitution, documentation sync, env
      validation, task completion, and test engineering.
- [x] Push the branch, create a PR against `main`, include required preflight/specialist
      evidence, monitor CI, fix failures until required checks are green, and leave the PR open
      and unmerged.

## Implementation notes

- Out-of-scope degraded sleeping session snapshot purge follow-up captured as SAM Idea
  `01M05HTJHCWXCG5YZJ6TB3Y2AG`.

## Local validation evidence

- `pnpm typecheck` — passed
- `pnpm lint` — passed with pre-existing warnings only
- `pnpm quality:migration-safety` — passed
- `pnpm quality:migration-ordering` — passed
- `pnpm quality:wrangler-bindings` — passed
- `pnpm format:check` — passed
- `pnpm lint:oxlint` — passed, report-only diagnostics
- `pnpm quality:type-boundaries` — passed, blocking counts zero
- `pnpm --filter @simple-agent-manager/api typecheck` — passed after final test coverage
  adjustment
- `pnpm --filter @simple-agent-manager/api lint` — passed after final test coverage
  adjustment
- `pnpm --filter @simple-agent-manager/api test -- tests/unit/services/deployment-control.test.ts tests/unit/routes/deploy-release-callback.test.ts tests/unit/routes/compose-publish-release-callback.test.ts tests/unit/routes/deployment-release-compose-submission.test.ts tests/unit/routes/deployment-environment-observability.test.ts tests/unit/routes/deployment-environment-lifecycle-vertical.test.ts tests/unit/services/deployment-volumes.test.ts tests/unit/scheduled/d1-retention.test.ts`
  — passed, 8 files / 143 tests
- `pnpm --filter @simple-agent-manager/api test` — passed, 547 files / 7,367 tests
- `pnpm test` — passed on rerun, 21 / 21 turbo tasks green; API 547 files / 7,367 tests.
  The first root attempt hit two unrelated MCP route `beforeEach` hook timeouts under root-run
  concurrency; both timed-out files passed when rerun directly (`24 / 24`) before the full root
  rerun passed.
- After PR CI exposed missing deploy workflow env mappings, updated
  `.github/workflows/deploy-reusable.yml` and reran:
  - `npx tsc --project scripts/deploy/tsconfig.json --noEmit`
  - `npx tsx --check scripts/deploy/setup-github.ts`
  - `npx tsx --check scripts/deploy/sync-wrangler-config.ts`
  - `npx tsx --check scripts/deploy/generate-keys.ts`
  - `pnpm quality:scripts:test`
  - `pnpm quality:wrangler-bindings`
  - `pnpm quality:agent-install-manifest`
  - `pnpm exec vitest run --config scripts/quality/vitest.config.ts ci-quality-program.test.ts ci-worker-suite.test.ts deployment-workflow-hardening.test.ts deploy-reusable-workflow.test.ts`

## Staging verification evidence

- Staging deploy workflow run `31955562805` passed for branch
  `sam/build-pr-safely-reconciles-xx84f3`.
- Deploy job passed, including database migrations and Worker health check.
- Smoke tests passed: 12 Playwright tests.
- Read-only staging D1 verification confirmed `deployment_releases.status_updated_at` exists,
  `idx_deployment_releases_status_updated_at` exists, and migration
  `0112_deployment_release_status_updated_at.sql` is recorded.
- After `main` advanced with `0112_session_snapshot_direct_upload_authorization.sql` and
  `0113_session_snapshot_capture_error.sql`, this PR's additive migration was renumbered to
  `0112_deployment_release_status_updated_at.sql` with no SQL content change.
- No production data was mutated; production evidence was used only to justify the stale-state
  lifecycle gap.

## PR / CI evidence

- PR: https://github.com/raphaeltm/simple-agent-manager/pull/1837
- PR remains open and unmerged.
- PR check rollup is the source of truth for final head status; CI was green after follow-up
  implementation fixes before archiving:
  - Main PR workflow run `31957889584` passed required checks, including Build, Code Quality
    Checks, Durable Object Workers, Lint, Preflight Evidence, Pulumi Infrastructure Tests,
    Secret Scan, Specialist Review Evidence, Test, Type Check, UI Compliance, Validate Deploy
    Scripts, and Workspace Quality Surfaces.
  - VM smoke workflow run `31957889570` passed worker and mock smoke jobs.
  - Benchmark workflow run `31957889592` passed.

## Specialist review evidence

| Reviewer                     | Verdict | Evidence                                                                                                                                                                                                                                                                                                                                                                              |
| ---------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cloudflare specialist        | PASS    | Additive D1 migration only (`apps/api/src/db/migrations/0112_deployment_release_status_updated_at.sql`); bounded parameterized D1 update with `LIMIT ?` and no production mutation (`apps/api/src/scheduled/d1-retention.ts`); R2 cleanup ordering verified by test; `pnpm quality:migration-safety`, `pnpm quality:migration-ordering`, and `pnpm quality:wrangler-bindings` passed. |
| Constitution validator       | PASS    | New business limits/time windows are configurable via `DEPLOYMENT_RELEASE_RECONCILIATION_*` env vars with default constants, not bare literals; no new internal URLs or deployment-specific identifiers; status strings are domain state-machine constants.                                                                                                                           |
| Documentation sync validator | PASS    | Updated `apps/api/src/env.ts`, `apps/api/.env.example`, `scripts/deploy/sync-wrangler-config.ts`, `.claude/skills/env-reference/SKILL.md`, `apps/www/src/content/docs/docs/reference/configuration.md`, and `apps/www/src/content/docs/docs/architecture/overview.md`. Optional Worker variables do not require GH/GITHUB secret mapping.                                             |
| Env validator                | PASS    | New variables are Worker runtime vars with `DEPLOYMENT_RELEASE_RECONCILIATION_*` prefix; no GitHub Actions secret prefix mapping needed; code/docs/defaults agree across Env, `.env.example`, env-reference, public config docs, and generated wrangler allowlist.                                                                                                                    |
| Test engineer                | PASS    | Added deterministic D1/R2 tests for fresh `created`/`applying`, active observed `applying`, stale `created`/`applying`, observed-applied protection, ordering into R2 cleanup, batching/idempotency, recent activity lease, disabled/configured behavior, malformed/future/unknown states, and deploy callback CAS conflict. Full API suite passed.                                   |
| Task completion validator    | PASS    | Research findings map to checked checklist items; all checked items have committed diff coverage; acceptance criteria have unit/vertical slice coverage or CI/PR-gate evidence; no UI/backend propagation or multi-resource discriminator gap in this backend scheduled-cleanup PR.                                                                                                   |

## Acceptance criteria

- Fresh `created`/`applying` compose releases remain protected.
- Releases actively reported as `applying`, or with recent apply/fetch events, remain protected.
- A stale non-terminal compose release with old status activity, stable authoritative observed
  node state, no recent release activity, and not matching `observed_applied_seq` transitions to
  terminal `failed`.
- Unknown/future/malformed release statuses and ambiguous observed environment state are not
  modified.
- Existing terminal release retention still protects observed-applied and newest-N releases, and
  only deletes terminal releases outside that window.
- R2 compose artifact cleanup continues to fail closed on malformed relevant manifests and only
  deletes old unreferenced objects.
- The reconciler is D1-only, batch-bounded, configurable, disabled by kill switch, and idempotent.
- CI required checks are green on the PR; the PR remains open/unmerged.
