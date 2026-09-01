# Archive-sharding rollout controls

## Problem

PR #1984 shipped the production-disabled ProjectData terminal archive-sharding bridge, but operators
still need safe rollout controls before a scoped staging or production canary. The controls must
inspect D1 journal/location/circuit-breaker state, expose recovery helpers safely, and provide a
manual project/session-scoped dry-run/canary path without enabling global cron selection.

Production data is critical: this task must not enable `PROJECT_DATA_ARCHIVE_SHARDING_ENABLED`, mutate
production configuration, or run a production canary.

## Research findings

- `apps/api/src/scheduled/project-data-archive-sharding.ts` already contains the core coordinator plus
  `freezeProjectDataArchiveMigration`, `poisonProjectDataArchiveMigration`,
  `inspectFrozenProjectDataArchiveIntents`, `copyBackProjectDataArchiveMigration`, and
  `rehomeProjectDataArchiveMigration`. These should be exposed behind superadmin admin routes rather
  than reimplemented.
- `runProjectDataArchiveSharding()` exits early unless `PROJECT_DATA_ARCHIVE_SHARDING_ENABLED=true`;
  the manual canary path needs a scoped entry point that does not depend on global cron selection, but
  dry-run must remain D1-only and must never call source deletion RPCs.
- D1 rollout state lives in `project_data_archive_migrations`,
  `project_data_session_locations`, and `project_data_archive_circuit_breakers` from migration
  `0135_project_data_archive_sharding_bridge.sql`; no schema change is needed for this slice.
- Existing admin storage routes live at `apps/api/src/routes/admin/project-data-storage.ts` and are
  mounted below `/api/admin/project-data/storage`. The parent `adminRoutes` applies
  `requireAuth()`, `requireApproved()`, and `requireSuperadmin()`, so new rollout endpoints belong on
  this sub-router.
- Request schemas use Valibot via `jsonValidator()` for required bodies and `parseOptionalBody()` for
  optional bodies. New mutation endpoints need explicit request schemas with bounded strings/limits.
- Existing route reference docs list ProjectData storage endpoints in `.claude/skills/api-reference`
  and public env/docs list archive-sharding variables in `.env.example` and
  `apps/www/src/content/docs/docs/reference/configuration.md`.
- Relevant rules: migration safety (no destructive D1 schema changes), control-loop I/O budgets
  (bounded selected candidates and wall time), runtime boundary validation, request I/O budgets,
  env/config documentation consistency, and storage-warning post-mortems that require operator-visible
  states.

## Checklist

- [x] Add bounded D1 rollout-state and failed/poisoned/frozen listing helpers.
- [x] Add scoped manual archive-sharding canary helper with dry-run default, project/session filters,
      tiny budgets, and no global-cron flag dependency.
- [x] Add project circuit-breaker/freeze controls with explicit reason and audit-friendly result.
- [x] Expose superadmin admin routes for state, problem migrations, dry-run/canary, freeze/unfreeze,
      frozen-intent inspection, copy-back, and rehome.
- [x] Add Valibot schemas for every new request body.
- [x] Add route/service tests for auth, bounded limits, scoped selection, dry-run no-op behavior,
      disabled-by-default behavior, and no source deletion from dry-run.
- [x] Update API/env docs for the operator sequence and rollout model.
- [x] Run focused API tests plus lint/typecheck/build as appropriate.
- [x] Run specialist reviews: cloudflare-specialist, security-auditor, env-validator,
      doc-sync-validator, constitution-validator, test-engineer, and task-completion-validator.
- [ ] Open a PR and stop; do not merge or run production canary.

## Acceptance criteria

- Global archive sharding remains disabled by default and the scheduled coordinator still skips when
  `PROJECT_DATA_ARCHIVE_SHARDING_ENABLED` is not `true`.
- Superadmins can inspect D1 archive-sharding journal/session-location/circuit-breaker state by
  project and optionally session with bounded limits.
- Superadmins can list failed, poisoned, and frozen migrations with bounded limits.
- Frozen-intent inspection, copy-back, and rehome are reachable only through superadmin admin routes
  and retain existing safety preconditions.
- Manual canary dry-run defaults to no-op and cannot create D1 candidate rows, call ProjectData owner
  RPCs, write R2, or delete source rows.
- Manual non-dry-run canary work is scoped to exactly one project and optionally one session, with
  one-session selection by default and existing migration finalization safety unchanged.
- Project freeze/unfreeze/circuit-breaker responses include the project id, requested state, reason,
  affected rows, and timestamp.
- Docs describe the safe operator sequence: inspect, dry-run a scoped target, optionally run a scoped
  canary, inspect failures, freeze/copy-back/rehome if needed, and only later consider global cron.

## References

- `tasks/active/2026-08-31-projectdata-terminal-archive-sharding.md`
- `apps/api/src/scheduled/project-data-archive-sharding.ts`
- `apps/api/src/services/project-data-archive-routing.ts`
- `apps/api/src/routes/admin/project-data-storage.ts`
- `apps/api/src/db/migrations/0135_project_data_archive_sharding_bridge.sql`
- `apps/api/src/project-data-archive/contract.ts`
- `apps/api/tests/unit/scheduled/project-data-archive-sharding.test.ts`
- `apps/api/tests/workers/project-data-archive-sharding.test.ts`
- `scripts/deploy/project-data-archive-routing-guard.ts`
