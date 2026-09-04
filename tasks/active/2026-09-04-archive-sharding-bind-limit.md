# Task: Fix SQLite bind-variable limit failure in archive-sharding chunk verification

## Problem Statement

Production archive-sharding canary runs fail with `too many SQL variables at offset 421: SQLITE_ERROR` for any session with more than 100 messages. The bug is in `readCommittedRowsForChunk` (`apps/api/src/durable-objects/project-data/archive-sharding.ts:1127-1148`), which builds `WHERE <key> IN (?, ?, ...)` with one bind per chunk row. The Cloudflare workerd SQLite build fails statements binding more than 100 variables (already documented in `apps/api/src/services/file-library-config.ts:70-78` as `d1BindVariableLimit = 100`). The default chunk size is 500 rows (`PROJECT_DATA_ARCHIVE_DEFAULT_CHUNK_ROWS`, `contract.ts:87`), so every chunk with >100 rows fails deterministically during post-insert verification.

The same helper is used by the rollback/recovery path `restoreSourceArchiveChunk` (line 1588), so copy-back restore fails identically.

Production impact: 5 failed sessions in project `01KHRJGANBBWGDY1NZ0KVF0D4J` (1 poisoned after 3 attempts, 4 failed); session `e2c249ce-…` was at attempt 2 of 3 before this fix. The canary only ever validated 2-message sessions — every session >100 messages fails.

## Research Findings

- **Root cause is the verification read, not the INSERT.** `insertArchiveRow` (lines 1102-1124) inserts one row per statement (8/5/15 binds) and can never hit the limit. `readCommittedRowsForChunk` binds exactly `rowCount` variables in the `IN` list.
- **Offset 421 arithmetic proves the limit is 100:** for the `chat_messages` column list the first `?` sits at byte offset 121, and 421 = 121 + 3×100 — the 101st placeholder. `chat_messages_grouped` (first `?` at 96) and `tool_payload_archives` (first `?` at 329) fail at 396/629 respectively — same 101-variable boundary.
- **Column count is irrelevant** — the `IN` list binds exactly rowCount, not rowCount × columns.
- **Do NOT reduce `chunkRows`.** A 5190-message session at 100 rows/chunk becomes ~52 chunks × 3 tables of (source DO RPC + R2 put + target DO RPC) inside a single invocation — the wall-time break (`scheduled/project-data-archive-sharding.ts:2406`) only fires between migrations, never inside `copyChunks`, risking the Workers subrequest ceiling.
- **Ordering is load-bearing.** `commitArchiveTargetChunk` (line 1199) and `restoreSourceArchiveChunk` (line 1588) hash the returned rows with `canonicalRowsSha256` against the source chunk hash. `rowIds` arrives in `spec.orderBy` order and each sub-batch query re-applies `ORDER BY ${spec.orderBy}`, so sequentially concatenating batch results preserves the global order. No reordering or unordered merge.
- **Completeness check must become a total.** `rows.length !== rowIds.length` must be computed across all sub-batches combined.
- **Existing precedent:** `apps/api/src/services/file-library-config.ts:70-78` — `getTagQueryBatchSize()` comments "Cloudflare D1 fails at 101 bound variables" and caps at `d1BindVariableLimit = 100` (currently function-local; `LIBRARY_DEFAULTS.TAG_QUERY_BATCH_SIZE = 80`). The archive path never got this limit.
- **Test gap (rule-69 shape):** the largest fixture anywhere is 12 rows (`apps/api/tests/workers/project-data-archive-sharding.test.ts:148`); DO unit tests use `maxRows` 1 and 10. The unit tests run on better-sqlite3, whose variable limit is 999+, so they can never catch this — only a Workers-runtime test (real workerd DO SQLite via `@cloudflare/vitest-pool-workers`) exercises the real 100-variable ceiling.
- **Workers test config:** `vitest.workers.config.ts` does not set `PROJECT_DATA_ARCHIVE_CHUNK_ROWS`, so the default 500 applies unless a test overrides it (the existing test overrides to '3' — my new test must NOT).

## Implementation Checklist

- [x] Export `d1BindVariableLimit` from `apps/api/src/services/file-library-config.ts` (single shared constant; extend its comment to note it applies to workerd SQLite in both D1 and DO storage).
- [x] Sub-batch the `WHERE <key> IN (...)` query inside `readCommittedRowsForChunk` in groups of `d1BindVariableLimit`, preserving `spec.orderBy` order via sequential slice concatenation.
- [x] Make the completeness check (`rows.length !== rowIds.length`) a total across all sub-batches.
- [x] Confirm both callers (`commitArchiveTargetChunk`, `restoreSourceArchiveChunk`) flow through the fixed helper (no caller changes needed — the fix is in the shared helper).
- [x] Add a Workers-runtime test in `apps/api/tests/workers/project-data-archive-sharding.test.ts` that migrates a >=101-message session with default chunk rows (single chunk >100 rows) through real DO SQLite and verifies the migration succeeds, routing returns all messages, and the target recorded a single >100-row `chat_messages` chunk.
- [x] Run the full quality suite (`pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`).

## Acceptance Criteria

1. `readCommittedRowsForChunk` never binds more than 100 variables in one statement, for any chunk size up to the 10,000-row cap.
2. Concatenated sub-batch results preserve `spec.orderBy` global order (the recomputed `canonicalRowsSha256` still matches the source chunk hash — asserted by the existing hash invariants and the new test).
3. The missing-row invariant still fails closed when the total across sub-batches does not equal `rowIds.length`.
4. Only one definition of the 100-variable limit exists in the codebase (shared constant, no third copy).
5. A Workers-runtime test with a >=101-row chunk fails on the unfixed code (`too many SQL variables`) and passes after the fix.
6. No reduction of `chunkRows` defaults; no changes to PRs #2010, #2011, #2015, #2016; no refactor of surrounding code.

## References

- Investigation task: 01M1PSMZZH144Z5AXC8HBPBSYP (completed; full byte-exact offset analysis in its outputSummary)
- Prior failed attempt: 01M1PZ8EKA6A5JSHZ30ZQ9J4AB (node_stale_heartbeat — no code pushed)
- Production failures: 5 sessions in project 01KHRJGANBBWGDY1NZ0KVF0D4J (e2c249ce-… 5190 msgs poisoned; 13329d54-… 1600 msgs; candidates 4230/2800/2639 msgs)
- Design doc task: `tasks/active/2026-08-31-projectdata-terminal-archive-sharding.md`
- Rollout controls task: `tasks/active/2026-09-01-archive-sharding-rollout-controls.md`
