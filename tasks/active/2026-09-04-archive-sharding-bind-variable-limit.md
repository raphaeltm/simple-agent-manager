# Fix SQLite bind-variable limit in archive-sharding chunk verification

**Status:** active
**SAM task:** `01M1Q8NH6D8K8QG18JKKYP8PKF`
**Branch:** `sam/fix-sqlite-bind-variable-yp8pkf`
**Parent work:** `tasks/active/2026-08-31-projectdata-terminal-archive-sharding.md`

## Problem

Production archive-sharding canary runs on project `01KHRJGANBBWGDY1NZ0KVF0D4J` fail for every
session with more than 100 messages:

```
too many SQL variables at offset 421: SQLITE_ERROR
```

`readCommittedRowsForChunk` (`apps/api/src/durable-objects/project-data/archive-sharding.ts:1127`)
is the post-insert verification read. It builds

```sql
SELECT <cols> FROM <table> WHERE <key> IN (?, ?, …) ORDER BY <orderBy>
```

with **one bind per chunk row**. `PROJECT_DATA_ARCHIVE_CHUNK_ROWS` defaults to 500 (production is
500), so every chunk above 100 rows exceeds the bind ceiling and throws.

The failure is *not* the INSERT: `insertArchiveRow` inserts one row per statement (8/5/15 binds for
`chat_messages` / `chat_messages_grouped` / `tool_payload_archives`) and can never hit the limit.

### The limit is 100, not 999

Offset 421 proves it. For the `chat_messages` column list the first `?` in the verification query
sits at byte offset 121, and `421 = 121 + 3 * 100` — the 101st placeholder. Cloudflare's SQL
surfaces (D1 and Durable Object `SqlStorage`) both reject the 101st bound parameter.

The repository already encodes this: `apps/api/src/lib/d1-limits.ts` exports
`D1_MAX_BOUND_PARAMETERS = 100`, consumed by seven services. The archive path never used it.
(`apps/api/src/services/file-library-config.ts:70-78` holds a third, function-local copy named
`d1BindVariableLimit`; see Follow-ups.)

## Research findings

| Finding | Consequence |
|---|---|
| `readCommittedRowsForChunk` is the only caller-sized (unbounded) bind list in `archive-sharding.ts`. The other builders bind `CHAT_SESSION_ANCHOR_COLUMNS` (17), `spec.columns` (≤15) or `roles` (small enum). | Fix is genuinely one function; no wider sweep needed in this file. |
| It has **two** callers: `commitArchiveTargetChunk:1199` (forward copy) and `restoreSourceArchiveChunk:1588` (copy-back / rollback recovery). | Fixing the shared helper fixes both; the rollback path was equally broken. |
| `rowIds` is produced by `exportArchiveRowsChunk:1481` as `rows.map(keyColumn)`, where `rows` came from `ORDER BY ${spec.orderBy}`. | `rowIds` is already in global `orderBy` order — sequential slices concatenate to the correct global order. |
| Every `spec.orderBy` is a **total** order ending in the unique key column (`… , id ASC` / `… , message_id ASC`). | No tie ambiguity; per-batch `ORDER BY` is deterministic. |
| The caller re-hashes the returned rows with `canonicalRowsSha256(spec.columns, committedRows)` and compares to the source chunk hash. | Row order is load-bearing. Do not reorder or unordered-merge. |
| Sub-batching introduces a **new** precondition that did not exist before: pre-fix, ordering came entirely from SQL; post-fix it depends on `rowIds` being globally sorted. | The new precondition needs its own explicit guard + test (rules 62, 67). |
| Reducing `chunkRows` to 100 instead would turn the 5190-message session into ~52 chunks × 3 tables of (source DO RPC + R2 put + target DO RPC) inside a **single** invocation — the wall-time break (`scheduled/project-data-archive-sharding.ts:2406`) only fires *between* migrations, never inside `copyChunks`. | Rejected: risks the Workers subrequest ceiling. Sub-batch the read instead. |
| The DO unit tests (`tests/unit/durable-objects/project-data-archive-sharding.test.ts`) run on `better-sqlite3`, whose bind ceiling is far above 100. | A unit test **cannot** reproduce this. The regression test must run in the Workers runtime (`tests/workers/`, real workerd `SqlStorage`). |
| Largest fixture anywhere in the archive suite is 12 rows; the DO unit test uses `maxRows: 1` / `10`. | Rule-69 shape: the path only breaks in a configuration the suite never exercises. |
| Production state: 9 "successful" canary sessions all had `message_count = 2`. Failures: `e2c249ce` (5190 msgs, `attempt_count = 2`), `13329d54` (1600 msgs). Candidates `fb9099ca` (4230), `79302770` (2800), `3795f55b` (2639) will fail identically. `PROJECT_DATA_ARCHIVE_POISON_AFTER_ATTEMPTS = 3`. | The canary validated nothing beyond trivial sessions. **Do not re-run the canary before this lands** — one more attempt poisons `e2c249ce`. |

## Implementation checklist

- [ ] Import the existing `D1_MAX_BOUND_PARAMETERS` from `apps/api/src/lib/d1-limits.ts` into
      `archive-sharding.ts` — do not introduce another copy of `100`.
- [ ] Sub-batch `readCommittedRowsForChunk` into slices of at most `D1_MAX_BOUND_PARAMETERS`,
      following the established offset-slice pattern in `services/diagnostic-incidents.ts:630`.
- [ ] Keep each sub-batch's SQL byte-identical to the pre-fix statement apart from the placeholder
      count, including `ORDER BY ${spec.orderBy}`.
- [ ] Concatenate slices in `rowIds` order so the global sequence is preserved.
- [ ] Make the completeness check a **total** across all sub-batches, preserving the existing
      `target_chunk_missing_rows` invariant reason.
- [ ] Add an ordering guard: the concatenated key sequence must equal `rowIds` exactly, with a new
      `target_chunk_row_order_mismatch` invariant reason, so the newly-introduced precondition
      fails fast and diagnosably instead of surfacing later as a confusing hash mismatch.
- [ ] Do **not** change `PROJECT_DATA_ARCHIVE_DEFAULT_CHUNK_ROWS` or any chunk config.
- [ ] Add a Workers-runtime regression test driving the **real** trigger
      (`runProjectDataArchiveSharding`) over a session with ≥101 messages in one chunk, asserting
      the migration completes and all rows land in the target. Verify it fails against pre-fix code.
- [ ] Add Workers-runtime boundary coverage at 100 (largest single batch) and a multi-batch size,
      exercising both callers — forward commit and copy-back restore.
- [ ] Add a unit test for the ordering guard (engine-agnostic, so `better-sqlite3` is fine).
- [ ] Prove every new guard discriminating: remove it, confirm exactly the intended test goes red,
      restore.

## Acceptance criteria

1. A session with ≥101 messages migrates end-to-end through the real scheduled sweep at the
   production chunk-row setting, with zero `too many SQL variables` errors.
2. The regression test fails against pre-fix code (verified and recorded).
3. `restoreSourceArchiveChunk` (copy-back/rollback) is covered by the same guarantee.
4. Row order returned by `readCommittedRowsForChunk` is byte-identical to pre-fix output for any
   input the exporter can produce, so `canonicalRowsSha256` still matches the source chunk hash.
5. The completeness check counts across all sub-batches; a missing row still raises
   `target_chunk_missing_rows`.
6. No new copy of the literal `100`; `D1_MAX_BOUND_PARAMETERS` is the single source.
7. `chunkRows` and every other archive config default is unchanged.

## Non-goals / constraints

- Targeted fix only. No refactor of surrounding archive-sharding code.
- Do **not** modify, close, or merge PRs #2010, #2011, #2015, #2016 (policy `c62c403e`).
- Do not enable production archive routing, global sweep, or any production data mutation
  (policy `66060db4` — production mutations are the final gate and need explicit approval).

## Follow-ups (not in this PR)

- **Idea `01M1QBD7XFWMPA4PCZHJZS3CKG`** — `apps/api/src/services/file-library-config.ts:70-78` still
  holds a function-local `d1BindVariableLimit = 100` duplicating `D1_MAX_BOUND_PARAMETERS`.
  Different subsystem with its own tests, and there it is a *cap* on an env-configurable value
  rather than a batch size, so collapsing it needs care. Deferred deliberately.
- **Idea `01M1QBCXT0QND28MT3JFYMF1GE`** — repo-wide audit of the remaining caller-sized `IN (…)`
  builders (comments, project-events, prompt-delivery, sessions, library-file-comments,
  acp-sessions, task-wait-supervisor). Each is fed from an upstream page-limited or enum-bounded
  list today, but none of them states or enforces that bound. Includes a proposal for a
  `scripts/quality/` scanner, since reviewer diligence has already failed once on this class.

## References

- Investigation: SAM task `01M1PSMZZH144Z5AXC8HBPBSYP` (read-only, completed)
- Precedent: `apps/api/src/lib/d1-limits.ts`, `apps/api/src/services/diagnostic-incidents.ts:630`
- `.claude/rules/69-emergency-config-paths-need-their-own-coverage.md` — a path that only breaks in
  a configuration the suite never exercises
- `.claude/rules/62-tests-must-observe-the-real-trigger.md` — enter through the real trigger
- `.claude/rules/44-dual-write-migration-enumerate-writers.md` — enumerate every path
- `.claude/rules/28-credential-resolution-fallback-tests.md` — SQL behaviour needs a real SQL engine
