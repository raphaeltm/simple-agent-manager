# Fix duplicate D1 migration prefixes and add regression guard

## Problem

The API/data audit task `01KXT1E0Z1GNCNQ5HYZVE67SB5` reported duplicate D1 migration filename prefixes. Duplicate numeric prefixes make migration ordering ambiguous for humans and reviewers. Because Wrangler tracks applied D1 migrations by migration name, renaming already-applied migrations could cause existing databases to treat historical migrations as new work. This remediation must therefore be non-breaking.

## Research findings

- Primary D1 migrations live in `apps/api/src/db/migrations/`.
- Observability D1 migrations live in `apps/api/src/db/migrations/observability/`.
- `apps/api/wrangler.toml` maps `DATABASE` to `src/db/migrations` and `OBSERVABILITY_DATABASE` to `src/db/migrations/observability`.
- GitHub deployment currently uses `wrangler d1 migrations apply` for both databases in `.github/workflows/deploy-reusable.yml`.
- `scripts/deploy/run-migrations.ts` shells out to `wrangler d1 migrations apply`.
- Existing CI already runs `pnpm quality:migration-safety` from `.github/workflows/ci.yml`.
- Current historical duplicate prefixes in the primary directory are `0002`, `0013`, `0016`, `0024`, `0029`, `0036`, `0037`, `0042`, `0052`, and `0069`. These should be treated as legacy allowed duplicates, not renamed.

## Implementation checklist

- [x] Add a D1 migration ordering quality check that scans both configured D1 migration directories.
- [x] Preserve current historical duplicate prefixes through an explicit allowlist.
- [x] Fail on any future duplicate numeric prefix not in the allowlist.
- [x] Fail on migration files without numeric prefixes and non-SQL entries that could affect review/order ambiguity.
- [x] Add regression tests for the current repo, new duplicate prefix detection, and ambiguous filename detection.
- [x] Wire the new quality check into package scripts and CI.

## Acceptance criteria

- No already-applied migration filenames are renamed.
- CI has a regression guard for duplicate/ambiguous D1 migration ordering.
- Local relevant quality checks pass.
- Specialist reviews are completed and recorded.
- PR states this is non-breaking and includes test evidence.
