# Fix SQLite bind variable limit in archive sharding chunk verification

## Problem

Production archive-sharding canary runs fail with `too many SQL variables at offset 421:
SQLITE_ERROR` for any session with more than 100 messages. Five sessions in project
`01KHRJGANBBWGDY1NZ0KVF0D4J` failed this way (1 poisoned, 4 failed).

The bug is in `readCommittedRowsForChunk`
(apps/api/src/durable-objects/project-data/archive-sharding.ts:1127-1148). It builds
`WHERE id IN (?, ?, ...)` with one bind per chunk row. Cloudflare's SQLite runtime (D1 and
Durable Object storage alike) rejects statements with more than 100 bound parameters —
documented in `apps/api/src/lib/d1-limits.ts` as `D1_MAX_BOUND_PARAMETERS = 100` and in
`apps/api/src/services/file-library-config.ts:70-78`. The default chunk size is 500 rows
(`PROJECT_DATA_ARCHIVE_DEFAULT_CHUNK_ROWS`), so every chunk with more than 100 rows fails
during target commit verification.

Both call paths share the helper:

- `commitArchiveTargetChunk` (archive-sharding.ts:1199) — forward copy verification
- `restoreSourceArchiveChunk` (archive-sharding.ts:1588) — rollback/copy-back recovery

## Research findings

- A shared constant already exists: `D1_MAX_BOUND_PARAMETERS` in
  `apps/api/src/lib/d1-limits.ts`, consumed by seven services with the established
  `slice(offset, offset + D1_MAX_BOUND_PARAMETERS)` sub-batching pattern (e.g.
  `services/diagnostic-incidents.ts:630`, `services/platform-feedback-triage/persistence.ts:107`).
  `file-library-config.ts` keeps its own local `d1BindVariableLimit` with an explanatory
  comment; this fix uses the shared constant and does not add a third copy of `100`.
- `rowIds` is produced by `exportArchiveRowsChunk` (archive-sharding.ts:1481) from rows
  read `ORDER BY ${spec.orderBy}`, so it arrives in `spec.orderBy` order. Sequential
  rowId slices, each queried with the same `ORDER BY`, concatenated in slice order
  therefore preserve the global order the caller re-hashes with `canonicalRowsSha256`.
- The completeness guard (`rows.length !== rowIds.length` →
  `target_chunk_missing_rows`) must become a total across all sub-batches.
- `chunkRows` must NOT be reduced: a 5190-message session would become ~52 chunks × 3
  tables of (DO RPC + R2 put + DO RPC) inside one invocation, risking the Workers
  subrequest ceiling. Sub-batching happens inside the single verification read instead.
- The existing Workers-runtime suite's largest fixture is 12 messages
  (tests/workers/project-data-archive-sharding.test.ts) and it forces
  `PROJECT_DATA_ARCHIVE_CHUNK_ROWS: '3'`, so a >100-row chunk is never exercised — a
  rule-69 shape (the configuration that breaks is never the one the suite runs).
- better-sqlite3 unit tests cannot catch this: its default bind limit is far above 100.
  Only the real workerd SQLite runtime (vitest-pool-workers) reproduces it.
- Copy-back is drivable end-to-end in the Workers runtime via
  `copyBackProjectDataArchiveMigration` (scheduled/project-data-archive-sharding.ts:2228);
  it requires `PROJECT_DATA_ARCHIVE_SHARDING_ENABLED === 'true'`
  (`isProjectDataArchiveExactRoutingEnabled`), which the existing tests already set.

## Implementation checklist

- [ ] Sub-batch `readCommittedRowsForChunk`'s `WHERE id IN (...)` into
      `D1_MAX_BOUND_PARAMETERS`-sized ordered slices imported from `lib/d1-limits`.
- [ ] Keep per-sub-batch `ORDER BY ${spec.orderBy}` and concatenate slices in sequence
      (no reorder, no unordered merge).
- [ ] Make the `target_chunk_missing_rows` completeness check total across sub-batches.
- [ ] Add a Workers-runtime test (real DO SQLite) migrating a >= 101-message session with
      chunk rows above the bind limit (default 500), which fails with
      "too many SQL variables" before the fix.
- [ ] Add a Workers-runtime test driving copy-back (`restoreSourceArchiveChunk` path) on
      the same > 100-row session.
- [ ] Add a unit test (better-sqlite3) whose chunk row count forces multiple sub-batches,
      proving slice concatenation preserves canonical hash equality and the total
      completeness check.

## Acceptance criteria

- A Workers-runtime migration of a 120-message session with default chunk rows (500)
  succeeds end-to-end: `migrated: 1`, source intent `source_deleted`, target contains all
  120 rows, and the pre-fix code fails the same test with `too many SQL variables`.
- Copy-back of the same session restores all rows through
  `restoreSourceArchiveChunk` with > 100 rowIds in one chunk and the committed hash
  matches the source chunk hash.
- Ordering is preserved: `commitArchiveTargetChunk`'s recomputed hash over concatenated
  sub-batches equals the source chunk hash for a multi-sub-batch chunk.
- No third copy of the 100 bind limit constant is introduced;
  `D1_MAX_BOUND_PARAMETERS` is the single source.
- `chunkRows` default (500) and its env override are untouched.
- Full quality suite (lint, typecheck, test incl. `test:workers`, build) passes.

## References

- Investigation task output: SAM task `01M1PSMZZH144Z5AXC8HBPBSYP`
- Parent task file: tasks/active/2026-08-31-projectdata-terminal-archive-sharding.md
- Precedent: apps/api/src/lib/d1-limits.ts, apps/api/src/services/file-library-config.ts:70-78
- Production failures: 5 sessions in project 01KHRJGANBBWGDY1NZ0KVF0D4J (1 poisoned, 4 failed)
- `.claude/rules/69-emergency-config-paths-need-their-own-coverage.md`
- `.claude/rules/31-migration-safety.md`, `.claude/rules/03-constitution.md` (Principle XI)
