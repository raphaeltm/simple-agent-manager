# Compute pools Wave 1A schema and types

## Problem

Wave 1A needs the durable D1/Drizzle foundation for compute/node pools without changing placement behavior. The schema must preserve existing rows, avoid copying secrets, and support v1 default-pool precedence plus later multiple pools and fallback chains.

## Constraints

- Base branch: `sam/compute-pools-integration`.
- Child branch: `sam/execute-task-using-skill-w9zme4`.
- Do not deploy to staging or mutate staging.
- Preserve scheduler/runtime behavior; this wave is schema, internal types, and tests only.
- Do not create public docs or strategy docs.

## Research findings

- Wave 0 integration commit `d148a2d3e` adds behavior-preserving placement tests in `apps/api/tests/integration/node-selection.test.ts` and `apps/api/tests/workers/vm-admission-control-races.test.ts`. Wave 1A must not refactor those selectors.
- D1 schema is centralized in `apps/api/src/db/schema.ts`; additive migrations live in `apps/api/src/db/migrations/`.
- Migration safety rule 31 requires additive changes for FK parents. Existing patterns use nullable `ALTER TABLE ... ADD COLUMN ... REFERENCES ... ON DELETE SET NULL` for `tasks` node references.
- Existing task/workspace rows already carry `placement_explanation_json`; nodes do not. New placement snapshot columns must be nullable so existing rows remain valid.
- Credentials remain canonical in `credentials` and `platform_credentials`; pool capacity sources should reference credential identity only and never store encrypted or plaintext secrets.
- Shared package conventions require new domain type files to be re-exported from `packages/shared/src/types/index.ts`.

## Implementation checklist

- [x] Add an additive D1 migration for `capacity_sources`, `capacity_pools`, candidate membership/config, fallback links, and nullable placement snapshot columns.
- [x] Mirror the migration in Drizzle schema with product-neutral `capacity_*` table names.
- [x] Add shared/internal TypeScript types for capacity source identity, pool scope/default/revision/status/strategy/exhaustion policy, candidates, fallback links, and placement snapshots.
- [x] Add API-side mapper helpers only for internal future-wave use/tests; do not expose new public API routes.
- [x] Add migration/schema tests proving existing rows remain valid with null pool fields.
- [x] Add constraint tests proving one default per user/project/installation scope and valid source credential relationships.
- [x] Add type/mapper tests covering source identity and placement snapshot shape.
- [x] Run focused local tests for the new migration/types.
- [x] Run CI-oriented local validation without staging.
- [x] Open child PR against `sam/compute-pools-integration`.

## Acceptance criteria

- Backward-compatible migrations and schema compile.
- Existing Wave 0 tests still pass or are not invalidated.
- New schema/type tests cover scope/default/revision/source relationships.
- Child PR is opened against `sam/compute-pools-integration`.
- Staging deployment and staging mutation are intentionally skipped by explicit instruction.

## Validation notes

- `pnpm --filter @simple-agent-manager/shared build` — passed.
- `pnpm --filter @simple-agent-manager/shared test -- tests/unit/capacity-pool.test.ts` — passed, 1 file / 4 tests.
- `pnpm --filter @simple-agent-manager/api test -- tests/unit/db/capacity-pool-migration.test.ts tests/unit/services/capacity-pools.test.ts` — passed, 2 files / 11 tests after shared build.
- `pnpm --filter @simple-agent-manager/shared typecheck` — passed.
- `pnpm --filter @simple-agent-manager/shared lint` — passed after mechanical import/export sort fix.
- `pnpm --filter @simple-agent-manager/api typecheck` — passed.
- `pnpm --filter @simple-agent-manager/api lint` — passed.
- `pnpm quality:migration-ordering` — passed.
- `pnpm quality:migration-safety` — passed.
- `pnpm --filter @simple-agent-manager/api test -- tests/integration/node-selection.test.ts tests/unit/db/capacity-pool-migration.test.ts tests/unit/services/capacity-pools.test.ts` — passed, 3 files / 40 tests.
- `pnpm --filter @simple-agent-manager/api exec vitest run --config vitest.workers.config.ts tests/workers/vm-admission-control-races.test.ts --reporter=verbose` — passed, 1 file / 10 tests.
- `pnpm format:check` — passed.
- `pnpm --filter @simple-agent-manager/api build` — passed.
- `pnpm --filter @simple-agent-manager/api test` — first run failed only because `tests/unit/services/node-selector-user-scope.test.ts` used a hand-written minimal `nodes` table missing new nullable columns; full collection was 620 files / 8456 tests.
- `pnpm --filter @simple-agent-manager/api test -- tests/unit/services/node-selector-user-scope.test.ts` — passed after fixture update, 1 file / 3 tests.
- `pnpm --filter @simple-agent-manager/api test` — passed after fixture update, 620 files / 8456 tests.
- `pnpm --filter @simple-agent-manager/shared test` — passed, 34 files / 617 tests.
- `pnpm check:fast` — passed.
- `pnpm build` — passed.
- `git diff --check` — passed.
- Child PR opened against `sam/compute-pools-integration`: https://github.com/raphaeltm/simple-agent-manager/pull/1946.

## Review notes

- `$cloudflare-specialist`: PASS — D1 changes are additive, timestamp fields use D1-compatible text defaults consistent with nearby schema, partial indexes cover nullable lookup fields, and no staging/Cloudflare state was touched.
- `$constitution-validator`: PASS — no new URLs, timeouts, runtime limits, issuer/audience IDs, or deployment-specific values were added; schema enum/check values are domain invariants.
- `$test-engineer`: PASS — new migration/schema tests cover legacy-null snapshots, scope/default uniqueness, credential-source constraints, candidates/fallbacks, and destructive-statement guard; mapper/shared tests cover type guards and fail-closed invalid persisted values.
- `$security-auditor`: PASS — capacity sources only reference `credentials`/`platform_credentials`; no token/IV/secret columns were added to pool tables; mapper and shared DTO tests assert no secret-shaped fields.
- `$task-completion-validator`: PASS — all research findings, checked checklist items, and acceptance criteria are represented in the diff, local validation, and child PR.
