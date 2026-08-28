# Default capacity pools Wave 2B

## Problem

Compute pools Wave 2B needs an internal, idempotent service that can lazily create default capacity sources, pools, and candidates from existing cloud credentials without changing scheduler behavior. This preserves current provisioning while giving later scheduler and UX waves durable pool records to read.

## Constraints

- Base branch: `sam/compute-pools-integration`.
- Child branch: `sam/execute-task-using-skill-v8p1qk`.
- Do not target `main` directly.
- Do not deploy to staging, mutate staging, or perform staging validation.
- Use local tests, code review, and CI only.
- Keep the PR focused; do not add public docs or strategy docs.
- Do not include unrelated `.codex/config.toml` changes.

## Research findings

- Wave 1A already added the additive `capacity_sources`, `capacity_pools`, `capacity_pool_candidates`, and `capacity_pool_fallbacks` schema in `apps/api/src/db/migrations/0125_compute_pool_foundation.sql`; no new schema is required for this slice.
- `capacity_sources` references `credentials.id` or `platform_credentials.id` and intentionally does not store `encrypted_token`, `iv`, or plaintext secrets.
- `capacity_pools` already has partial unique indexes for exactly one default installation, user, and project pool.
- Project cloud credentials are represented by legacy `credentials.project_id IS NOT NULL` rows and mirrored into composable `cc_*` compute attachments by `syncComputeCredentialToCC()`. The capacity source schema references the legacy credential row, so project pool creation must only use real project-scoped legacy credential rows.
- User default pools must only use user-scoped `credentials.project_id IS NULL` rows. They must not seed project pools from personal credentials.
- Installation default pools use enabled `platform_credentials` rows with `credential_type = 'cloud-provider'`.
- Candidate generation can use static provider/location and VM-size catalogs from `@simple-agent-manager/shared`; it must not fetch provider catalogs during task/login startup.
- Disabled credentials should not leave active default capacity available. Existing schema supports `status` on sources, pools, and candidates, and deleted credential rows cascade source/candidate rows.
- Wave 1B placement resolver centralizes task-start placement inputs but this wave must not flip scheduler behavior.

## Implementation checklist

- [x] Add an internal default capacity-pool service that ensures installation/user/project default pools from existing active credentials.
- [x] Use deterministic IDs and D1-compatible idempotent upserts so concurrent calls safely converge.
- [x] Generate workspace VM candidates from shared provider locations and VM-size constants for each active source.
- [x] Store only non-secret credential references/version metadata on sources.
- [x] Ensure user pools are seeded only from user-scoped credentials and project pools only from project-scoped credentials.
- [x] Reconcile disabled/deleted backing credentials by disabling empty/default pool availability where existing schema supports it.
- [x] Add a manual/backfill service helper that can ensure records for existing credentials without running a global backfill automatically.
- [x] Add an internal helper to lazily resolve effective default pool summaries with project → user → installation precedence.
- [x] Add tests for legacy no-pool state, idempotency, unique default per scope, scope/secret safety, candidate generation, and disabled/deleted behavior.
- [x] Run focused local validation, specialist reviews, and open a child PR against `sam/compute-pools-integration`.

## Acceptance criteria

- Existing installations can lazily get default pool/source records from existing credentials without changing current scheduler behavior.
- Tests cover migration/idempotency/scope safety.
- Child PR is open against `sam/compute-pools-integration`.
- Staging deployment and staging mutation are intentionally skipped by explicit instruction.

## Validation notes

- `pnpm --filter @simple-agent-manager/api test -- tests/unit/services/default-capacity-pools.test.ts` — passed, 1 file / 7 tests.
- `pnpm --filter @simple-agent-manager/api test -- tests/unit/services/capacity-pools.test.ts tests/unit/services/default-capacity-pools.test.ts tests/unit/db/capacity-pool-migration.test.ts` — passed, 3 files / 18 tests.
- `pnpm --filter @simple-agent-manager/api typecheck` — passed.
- `pnpm --filter @simple-agent-manager/api lint` — passed.
- `pnpm format:check` — passed.
- `pnpm --filter @simple-agent-manager/api test` — passed, 622 files / 8,471 tests.
- `pnpm --filter @simple-agent-manager/api build` — passed.
- `pnpm quality:migration-safety` — passed, 174 FK relationships scanned, 0 violations.
- `pnpm check:fast` — passed.
- `pnpm build` — passed, 9 successful tasks.
- `pnpm typecheck` — passed, 19 successful tasks.
- `pnpm lint` — passed, 13 successful tasks with warning-only diagnostics in unrelated packages.
- `pnpm test` — passed, 21 successful tasks. API: 622 files / 8,471 tests. Web: 294 files / 3,522 tests.
- Post-review patch validation:
  - `pnpm --filter @simple-agent-manager/api test -- tests/unit/services/default-capacity-pools.test.ts` — passed, 1 file / 7 tests.
  - `pnpm --filter @simple-agent-manager/api typecheck` — passed.

## Specialist review notes

| Reviewer | Status | Outcome |
| --- | --- | --- |
| task-completion-validator | PASS | Research findings, checked checklist items, and acceptance criteria map to the diff and validation evidence. Remaining unchecked item is the PR-opening step. No UI-to-backend path applies because this slice intentionally adds an unwired internal service. |
| cloudflare-specialist | PASS | D1 usage is Drizzle/SQLite-compatible, uses existing Wave 1A schema and indexes, avoids new migrations, and keeps candidate generation bounded to shared static catalogs. No KV/R2/wrangler/deployment changes. |
| security-auditor | PASS | Production service does not read, decrypt, log, or copy credential secrets. Capacity sources persist only credential IDs, non-secret references, provider identity, status, and timestamp-derived version metadata. |
| constitution-validator | PASS | No new URLs, timeouts, retry delays, quotas, or deployment-specific identifiers. Default literals are schema/shared-contract values for the new capacity-pool records. |
| test-engineer | PASS | Added service-to-D1 vertical-slice tests using the real Wave 1A migration, realistic foreign-key rows, multiple providers/scopes, idempotency, secret safety, and disabled/deleted credential behavior. |

Review hardening applied: project capacity seeds now set `ownerProjectId` from the requested `projectId` scope rather than the nullable selected column, making the project-scope invariant explicit.

## Pull request

- Child PR: https://github.com/raphaeltm/simple-agent-manager/pull/1949
- Base: `sam/compute-pools-integration`
- Head: `sam/execute-task-using-skill-v8p1qk`
