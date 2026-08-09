# Production R2 storage retention and cleanup

## Problem

Production R2 storage grows without a complete ownership/retention policy. Persisted
deployment releases keep superseded compose-image artifacts reachable forever,
expired session snapshot metadata remains in D1, temporary uploads and regenerated
TTS audio have no lifecycle expiry, and deleting a project leaves its durable library
metadata and objects orphaned.

This task delivers one cohesive retention PR. Cleanup must be bounded, tenant scoped,
observable, safe for stopped deployment environments, and non-destructive in staging
and production verification. Production reclamation occurs organically through the
merged scheduled sweeps and R2 lifecycle policies.

## Research findings

- `apps/api/src/scheduled/compose-image-artifact-cleanup.ts` protects every artifact
  referenced by any `deployment_releases.manifest`; deleting only superseded terminal
  release rows is therefore reference-count safe, and malformed retained manifests
  continue to fail closed. The current default delete batch is 50, too small for the
  validated 281-object backlog.
- `deployment_releases` has a unique `(environment_id, version)` key and terminal
  statuses `applied`/`failed`. Current deployment state is represented by
  `deployment_environments.observed_applied_seq`; created/applying and unknown future
  statuses must be retained. No current-release FK or rollback reader requires old
  terminal rows.
- The release retention predicate can be one bounded D1 delete: a terminal release is
  eligible only when at least N newer releases exist in the same environment and its
  version differs from that environment's `observed_applied_seq`. This naturally
  includes stopped environments and isolates each environment.
- `session_snapshots.expires_at` is indexed ISO-8601 text written with
  `Date.toISOString()`. R2 already expires `session-snapshots/`; the unused
  `deleteSessionSnapshotArtifacts()` helper should be removed and D1 metadata purged
  with a bounded indexed predicate.
- `infra/resources/storage.ts` already owns a single upgrade-safe
  `R2BucketLifecycle`; positive Pulumi TTL parsing lives in
  `infra/resources/config.ts`. Independent `temp-uploads/` and `tts/` prefix rules
  belong in that resource. `library/` and `compose-image-artifacts/` must not receive
  age-only lifecycle rules.
- Library keys are deterministically `library/{projectId}/{fileId}` via
  `packages/shared/src/types/library.ts:buildLibraryR2Key()`. `project_files.project_id`
  is intentionally a soft reference, so project deletion must explicitly delete tags
  and files by project predicate, then schedule strictly prefix-scoped R2 list/delete
  cleanup with structured failure logging.
- `scripts/deploy/d1-migration-safety.ts` accepts row decreases only for a closed,
  code-reviewed churning-table list (50% default bound, configurable 0-100). Register
  `DATABASE.deployment_releases`, `DATABASE.session_snapshots`, and
  `DATABASE.project_files`, add parser/verification tests, and update both deployment
  references so legitimate concurrent retention churn is not treated as unexpected
  business-table loss.
- The 2026-08-05 scheduled-handler outage showed that a throwing sweep silently
  suppressed every later maintenance job. Both new jobs must use
  `createSweepIsolator`, expose non-zero/undefined failure state in `cron.completed`,
  and have discriminating isolation coverage.
- Rule 47 requires bounded candidate sets and a two-pass zombie test. These sweeps do
  only local D1/KV work; successfully deleted candidates leave the result set and
  protected rows remain stable across a second pass.
- No schema migration is required: all predicates use existing tables, columns, and
  indexes. If implementation disproves this finding, stop and request human input
  before writing any migration.

## Implementation checklist

### Scheduled retention

- [x] Add an env-configurable, interval-gated deployment-release retention sweep with
      defaults for enabled state, keep count (3), batch size, interval, and KV marker.
- [x] Protect newest N per environment, the observed applied version, and every
      non-terminal/unknown-status release; delete only bounded applied/failed rows.
- [x] Add an env-configurable, interval-gated session-snapshot D1 purge using ISO
      expiry comparison and a bounded indexed delete.
- [x] Remove `deleteSessionSnapshotArtifacts()`; R2 lifecycle owns snapshot objects.
- [x] Wire both jobs as independent isolated scheduled steps and add completion-log
      counters before compose artifact cleanup.
- [x] Raise compose artifact cleanup's default batch from 50 to 250 so the current
      backlog drains in roughly one to two daily runs while preserving its override.

### R2 lifecycle and project cleanup

- [x] Add validated Pulumi defaults/overrides: `tempUploadTtlDays=1` and
      `ttsTtlDays=30`.
- [x] Add independent `temp-uploads/` and `tts/` lifecycle rules to the existing R2
      lifecycle resource for clean installs and upgrades; add no lifecycle for
      `library/` or `compose-image-artifacts/`.
- [x] Add explicit project-library tag/file delete statements scoped by project ID.
- [x] Schedule `library/{projectId}/` R2 list/delete cleanup with `waitUntil`, strict
      prefix validation, batched deletes, and structured failure context.

### Deploy safety and documentation

- [x] Register `DATABASE.deployment_releases`, `DATABASE.session_snapshots`, and
      `DATABASE.project_files` as reviewed churning tables in deploy row-count safety;
      pin their acceptance and the closed-list rejection behavior in tests.
- [x] Update `apps/api/src/env.ts`, `apps/api/.env.example`, the env-reference skill,
      and public self-host/configuration docs for every new runtime/config value and
      the expanded reviewed-table list.
- [x] Update infra config/storage tests for defaults, overrides, invalid TTLs, and all
      four independent lifecycle rules.
- [x] Move `tasks/backlog/2026-03-29-r2-temp-uploads-lifecycle-cleanup.md` to archive
      with an option-A completion note referencing this cohesive PR.

### Required tests

- [x] Real-SQL deployment release tests: old terminal pruning; newest-N retention;
      observed applied retention outside the window; stuck applying/unknown retention;
      per-environment isolation; batch bound; two-pass zombie/stability proof.
- [x] Real-SQL session snapshot tests: expired deletion; unexpired retention; exact ISO
      ordering/boundary behavior; batch bound; stable second pass.
- [x] Real-SQL library attack/control test: deleting project A removes only A's tags,
      rows, and R2 keys while project B remains intact; prove the pair discriminating.
- [x] Scheduled isolation regression naming a throwing new step and proving later steps
      still execute with an undefined failure result.
- [x] Preserve all existing compose artifact cleanup tests and update only the expected
      default/config documentation for the larger default batch.

### `/do` delivery gates

- [x] Run focused tests plus lint, typecheck, full test, and build.
- [x] Run task-completion, Cloudflare, environment, constitution, documentation, and
      test-engineering specialist reviews; address all blocking findings.
- [x] Check staging contention, deploy the branch, run the full regression checklist,
      verify both scheduled sweeps report no failures, and read the staging R2 lifecycle
      rules through the Cloudflare API with `$CF_TOKEN`; provision no VM/node.
- [ ] Create one PR, validate its live evidence locally, pass every CI gate, merge,
      monitor production deployment, and confirm the production scheduled handler runs
      the new sweeps without errors.

## Acceptance criteria

- Each environment retains its newest three releases by default, its observed-applied
  release even when older, and all non-terminal releases; only bounded old terminal
  rows are deleted.
- Expired session snapshot rows are purged in bounded batches without deleting valid
  rows; R2 snapshot expiry remains lifecycle-owned.
- `temp-uploads/` objects expire after one day and `tts/` objects after thirty days by
  default, with validated Pulumi overrides on both upgrades and clean installs.
- Deleting a project removes only that project's library rows/tags and asynchronously
  deletes only objects under its canonical library prefix.
- Deploy row-count verification recognizes the three intentionally shrinking tables
  without opening arbitrary tables to decrease tolerance.
- New limits, counts, intervals, flags, and TTLs have named `DEFAULT_*` constants and
  operator overrides; docs match code.
- Real-SQL and isolation tests prove the retention, tenant, batch, and zombie safety
  boundaries, and all `/do` local/staging/CI/production gates pass.
- Expected eventual production reclaim is approximately 108 GiB at keep-last-3 plus
  the compose artifact backlog drain; verification does not wait for the multi-day
  lifecycle/reclamation window.

## References

- `.claude/rules/01-doc-sync.md`
- `.claude/rules/13-staging-verification.md`
- `.claude/rules/28-credential-resolution-fallback-tests.md`
- `.claude/rules/47-control-loop-io-budget.md`
- `.claude/rules/53-scheduled-handler-isolation-and-liveness-signals.md`
- `tasks/archive/2026-06-27-compose-image-artifact-cleanup.md`
- `tasks/archive/2026-08-06-fix-node-reaping-orphan-reconciliation.md`
- `tasks/archive/2026-03-29-r2-temp-uploads-lifecycle-cleanup.md`

## Validation evidence

- Focused retention, project-delete/library, infra lifecycle, and deploy-safety suites
  pass, including the real-SQL route-entry attack/control test.
- Full API suite: 500 files and 6,760 tests passed. Full web suite: 243 files and
  2,936 tests passed.
- Repository typecheck, lint (existing warnings only), build, and D1 migration-safety
  gates pass.
- Specialist reviews all pass after addressing deployment-variable propagation,
  documentation taxonomy, pagination/fail-closed, waitUntil logging, and independent
  sweep-marker coverage.
- Staging workflow run 31289708182 passed at commit `97df79157`; its authenticated
  Playwright suite passed 12/12 dashboard, projects, settings, health/CORS, navigation,
  and browser-console checks. No VM or node was provisioned.
- Cloudflare API read of `sam-staging-assets` confirmed enabled `temp-uploads/` expiry
  at 86,400 seconds and `tts/` expiry at 2,592,000 seconds, while retaining the two
  existing lifecycle rules and adding no lifecycle for durable library/compose keys.
- Live tail of deployed Worker version `e3602f6a-0e62-4c7a-a13d-81713908202d`
  captured `cron.completed` with both new sweep counters, `failedSweeps: []`, and
  `failedSweepCount: 0`. The interval-gated no-op was expected after the initial run.
- PR [#1776](https://github.com/raphaeltm/simple-agent-manager/pull/1776) is mergeable
  with every applicable CI check passing. The mandatory task-completion validator found
  no implementation blockers; merge, production deployment monitoring, and production
  scheduled-handler confirmation remain explicit post-merge delivery follow-through.
