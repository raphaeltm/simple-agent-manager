# Archive sharding: streaming terminal hash, abandon operation, size-ordered budget

**Status:** active
**Branch:** `claude/sam-project-loading-zlgaux`
**Parent work:** `tasks/active/2026-08-31-projectdata-terminal-archive-sharding.md`,
`tasks/active/2026-09-04-archive-sharding-bind-variable-limit.md`,
`tasks/active/2026-09-03-projectdata-production-capacity-emergency.md`

## Problem

The SAM root ProjectData Durable Object (`01KHRJGANBBWGDY1NZ0KVF0D4J`) is at 10.256 GB against
the 10 GB SQLite ceiling and is intermittently reset for CPU time and overload (2026-09-04
15:10, 21:38, 23:08; 2026-09-05 11:50, 15:16). Archive sharding is the lever that matches the
data: terminal sessions past the 7-day grace hold 6.72M of 8.87M messages and (per the last
category breakdown) 2.94 GB of 3.24 GB of message text.

Manual canary runs on 2026-09-05 published five 9.9K-message sessions in ~40 s each, then two
sessions failed with:

```
Durable Object's isolate exceeded its memory limit and was reset.
```

- `7ed11dc5-21a9-4e15-80f4-2366b0b213b1` (100,000 messages) — journal `failed`, attempt 1.
- `1644a21e-549f-4a07-8f29-523cba239806` (9,906 messages, tool-heavy) — journal `failed`, attempt 1.

Both sessions are now fenced (`project_data_session_locations.location_state = 'migrating'`),
so `resolveExactReadOwner` refuses every read. `e2c249ce-8417-4b31-a361-ed3a79b2daf6` has been in
the same shape since 2026-09-04 (`frozen` location, `poisoned` journal from the bind-ceiling bug).
Their data is intact in root. Copy-back cannot help: `copyBackProjectDataArchiveMigration`
requires the source intent to be `source_deleted`. No existing operation returns a pre-copy
migration to `root`.

## Root causes

1. **Whole-session materialisation for hashing.** `tableAggregateSha256`
   (`apps/api/src/durable-objects/project-data/archive-sharding.ts`) runs
   `SELECT <cols> FROM <table> WHERE session_id = ?` with no paging, `toArray()`s every row,
   builds a single canonical string, then digests it. Memory scales with session bytes, not with
   the chunk budget. `computeTerminalVersion` runs it three times (messages, grouped, tool
   archives) and is called at prepare, seal, and finalize. `finalizeSourceDelete` and
   `rebuildTargetFts` also `toArray()` every grouped row of the session (rowid + content).
2. **No abandon path.** The journal state machine offers freeze, poison, and copy-back. All
   three leave the location fenced unless the source has already been deleted.
3. **Selection ignores size.** `selectCandidates` / `selectScopedCandidates` order by
   `updated_at ASC` and stop at `sweepSessions` rows (production default 1). A 100-message
   session and a 100,000-message session cost the same slot. The wall-time break only fires
   between migrations.

## Research findings

| Finding                                                                                                                                                                                                                                                                                        | Consequence                                                                                                                                                                                                                            |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The terminal-version digest is `sha256(rows.map(canonicalizeArchiveRow).join(''))` (`project-data-archive/hashing.ts`).                                                                                                                                                                        | Feeding the same bytes page by page into an incremental SHA-256 keeps the hash definition byte-identical. Existing published/sealed proofs stay valid.                                                                                 |
| `apps/api` runs with `nodejs_compat`; the Workers vitest pool sets the same flag. `node:crypto`'s `createHash` is incremental and available in workerd, the Workers pool, and the better-sqlite3 unit harness. Nothing in `apps/api/src` imports `node:crypto` yet; no ESLint rule forbids it. | Use `createHash('sha256')` with `update()` per row.                                                                                                                                                                                    |
| Every `ARCHIVE_TABLE_SPECS` entry already carries a total `orderBy`, `cursorPredicate`, `cursorValues`, `cursorFromRow` used by `exportArchiveRowsChunk`.                                                                                                                                      | The hash can page with the same seek predicates; no new SQL shape.                                                                                                                                                                     |
| The DO unit harness (`better-sqlite3`) enforces no memory ceiling (rule 69, harness-ceiling divergence).                                                                                                                                                                                       | The regression test must assert the observable shape: page count and max rows materialised per statement, plus digest equality against the one-shot definition.                                                                        |
| `prepareArchiveSourceIntent` inserts the source-intent row **before** hashing; a memory reset mid-hash aborts the request (writes inside the DO request roll back). `finalizeSourceDelete` is the only writer of `chat_sessions.archive_*` on the source.                                      | Abandon on the source only needs to delete the intent row (if any) when its state is not `source_deleted` / `rehome_exported`.                                                                                                         |
| `prepareArchiveTarget` inserts a `chat_sessions` anchor and a `project_data_archive_target_sessions` row in the shard; `commitArchiveTargetChunk` inserts rows + `project_data_archive_target_chunks`; `rebuildTargetFts` populates `chat_messages_grouped_fts`.                               | Abandon on the target must delete grouped rows with FTS delete markers, messages, tool archives, chunk rows, the target-session row, and the anchor, guarded by `validateTargetOwner` and refused for `published` / `rehome_exported`. |
| `freezeProjectDataArchiveMigration` is the model for a direct D1 journal update (`state NOT IN (...)` guard, lease cleared). `PROJECT_DATA_ARCHIVE_STATE_TRANSITIONS` allows `* -> frozen`.                                                                                                    | Abandon terminalises the journal as `frozen` with `error_code = 'operator_abandoned'` — no new persisted enum value, so no D1 CHECK change (rule 31). It must NOT open the project circuit breaker.                                    |
| Location reset to `root` already exists inside copy-back (owner_name = source, generation 0, migration_id NULL).                                                                                                                                                                               | Reuse that statement shape, guarded by `migration_id = ?` and `location_state IN ('migrating','frozen')`.                                                                                                                              |
| `selectScopedReclaimableMigrations` picks `failed` journals before new candidates.                                                                                                                                                                                                             | An untargeted canary retries failed migrations first; abandon must clear them so operators are not one poison away from an open breaker.                                                                                               |
| `session_summaries.message_count` is the only size figure in D1.                                                                                                                                                                                                                               | Order by `message_count DESC`, budget by cumulative `message_count`. A synced byte column is a follow-up.                                                                                                                              |
| Two coordinator tests rely on the default sweep size being 1 to prove reclaimable starvation handling.                                                                                                                                                                                         | Pin `PROJECT_DATA_ARCHIVE_SWEEP_SESSIONS='1'` explicitly in those tests when the default changes.                                                                                                                                      |

## Implementation checklist

### 1. Streaming terminal-version hash (DO)

- [x] Add `createCanonicalRowsHasher(columns)` in `project-data-archive/hashing.ts` backed by
      `node:crypto` `createHash('sha256')`; feed `` separators between rows exactly as
      `canonicalizeArchiveRows` joins them. Keep `canonicalRowsSha256` (used by chunk export) and
      add a test proving the two agree on the same rows, including an empty table.
- [x] Rewrite `tableAggregateSha256` to page with the table spec's cursor predicate and
      `LIMIT ?`; add `PROJECT_DATA_ARCHIVE_HASH_PAGE_ROWS` (default constant
      `PROJECT_DATA_ARCHIVE_DEFAULT_HASH_PAGE_ROWS = 500`, clamp 1..10000) threaded from the DO
      env into `computeTerminalVersion`.
- [x] Page `finalizeSourceDelete`'s grouped-row FTS delete loop and `rebuildTargetFts` the same
      way (bounded `LIMIT` batches by `rowid`).
- [x] Unit test (better-sqlite3): seed 1,205 messages (2 full pages + remainder), wrap
      `sql.exec` to record rows materialised per statement, assert max ≤ page size and the digest
      equals the one-shot definition. Verify it fails against the pre-fix code.
- [x] Workers-pool test: prepare + seal + finalize a session larger than one page through the
      real DO and assert `terminalVersionSha256` round-trips (seal does not report
      `target_terminal_version_mismatch`).

### 2. Abandon operation (DO + coordinator + admin route)

- [x] DO: `abandonArchiveSourceIntent(sql, input)` — `validateRootSourceOwner`, read intent, refuse
      `source_deleted` / `rehome_exported` (`abandon_requires_source_intact`), delete the intent row
      for the migration, return `{ removed }`.
- [x] DO: `abandonArchiveTargetSession(sql, input)` — `validateTargetOwner`, refuse `published` /
      `rehome_exported` (`target_not_abandonable`), delete grouped rows with FTS delete markers,
      messages, tool archives, chunk rows, target-session row, and anchor; return counts.
- [x] ProjectData index: RPC wrappers under the archive transcript lock / `transactionSync`.
- [x] Coordinator: `abandonProjectDataArchiveMigration(env, { migrationId, projectId, reason })`:
      journal must not be `source_deleted` / `published`; inspect source intent and refuse when
      deleted; target abandon; source abandon; then one D1 batch: journal -> `frozen` with
      `error_code = 'operator_abandoned'`, lease cleared; location -> `root`. Idempotent on rerun.
      Does not touch the circuit breaker.
- [x] Admin route `POST /:projectId/archive-sharding/migrations/:migrationId/abandon` with
      `ProjectDataArchiveRecoveryControlSchema`.
- [x] Coordinator unit tests: abandon from `failed` (pre-copy), from `poisoned` with partial target
      state, refusal from `source_deleted` and `published`, cross-project refusal, idempotent rerun,
      breaker untouched, session re-selectable as a fresh candidate afterwards.
- [x] DO unit tests: source abandon refuses `source_deleted`; target abandon removes every table's
      rows and FTS markers, refuses `published`.

### 3. Size-ordered, budgeted selection (coordinator)

- [x] `selectCandidates` / `selectScopedCandidates`: select `message_count`, order by
      `message_count DESC, updated_at ASC, id ASC`.
- [x] New config `sweepMessageBudget` from `PROJECT_DATA_ARCHIVE_SWEEP_MESSAGE_BUDGET` (default
      constant 20,000; clamp 1..5,000,000). New candidate journals are created while cumulative
      `message_count` stays within the budget, always at least one. `sweepSessions` remains the
      hard ceiling; raise `PROJECT_DATA_ARCHIVE_DEFAULT_SWEEP_SESSIONS` to 10.
- [x] Manual canary `limit` keeps its meaning (session ceiling); budget applies unchanged.
- [x] Tests: largest-first ordering with an older smaller session present; budget stops journal
      creation after the cumulative cap; single oversize session still selected; pin
      `PROJECT_DATA_ARCHIVE_SWEEP_SESSIONS='1'` in the two starvation tests.

### 4. Configuration and docs

- [x] `env.ts`, `wrangler.toml` top-level vars, `sync-wrangler-config.ts` optional list,
      `deploy-reusable.yml` `wrangler_sync_env` (both sync steps), `.env.example`,
      `.claude/skills/env-reference/SKILL.md`, `apps/www/.../reference/configuration.md`.
- [x] `.claude/skills/api-reference/SKILL.md`: abandon route; note copy-back vs abandon.
- [x] `CLAUDE.md` Recent Changes entry.
- [x] Post-mortem + process fix (rule 02): memory-ceiling sibling of rule 69's harness-ceiling
      section.

## Acceptance criteria

- [x] `computeTerminalVersion` never materialises more than `PROJECT_DATA_ARCHIVE_HASH_PAGE_ROWS`
      rows per statement and produces the same digest as the previous definition (test-pinned;
      the page-shape assertion fails against the one-shot implementation with
      `expected 1205 to be less than or equal to 500`).
- [ ] Abandon returns `7ed11dc5…`, `1644a21e…`, and `e2c249ce…` to `root` on production without
      touching message rows in root, and each can be re-migrated afterwards.
- [x] Sweep and canary pick the largest eligible sessions first and stop creating journals at the
      message budget.
- [ ] Staging: a >1-page session migrates end to end; an abandoned pre-copy migration reads again.

## Non-goals

- In-chunk wall-time breaks inside `copySourceChunks` (rejected in the bind-limit task).
- A synced per-session byte column in `session_summaries` (follow-up).
- Changing the global sweep cadence semantics.

## References

- `apps/api/src/durable-objects/project-data/archive-sharding.ts`
- `apps/api/src/scheduled/project-data-archive-sharding.ts`
- `apps/api/src/project-data-archive/hashing.ts`
- `apps/api/src/routes/admin/project-data-storage.ts`
- `.claude/rules/69-emergency-config-paths-need-their-own-coverage.md`
- `.claude/rules/47-control-loop-io-budget.md`
- `.claude/rules/31-migration-safety.md`

## Implementation notes (2026-09-05)

- Hash streaming uses `node:crypto` `createHash('sha256')` under `nodejs_compat`; the same bytes
  as `sha256Hex(canonicalizeArchiveRows(...))`, pinned by `tests/unit/project-data-archive-hashing.test.ts`.
- The page size reaches pure DO helpers as an explicit optional argument; the ProjectData DO
  wrappers fill it from `PROJECT_DATA_ARCHIVE_HASH_PAGE_ROWS` (`resolveArchiveHashPageRows`), so the
  coordinator RPC contract is unchanged (additive optional field only).
- A `sealed` target may be the only surviving copy once the source is deleted, and the target
  never transitions past `sealed` inside the shard. `abandonArchiveTargetSession` therefore refuses
  `sealed` unless the caller passes `sourceIntactVerified: true`, which the coordinator sets only
  after inspecting the root source intent. Discriminating test: sealed target without proof throws
  `target_sealed_requires_source_proof`; the same call with proof succeeds while the source is
  intact.
- Abandon freezes the journal with `error_code = 'operator_abandoned'` (no new persisted enum value,
  no D1 CHECK change) and does not open the project circuit breaker.
- `PROJECT_DATA_ARCHIVE_DEFAULT_SWEEP_SESSIONS` is now 10. The two coordinator tests that relied on
  the previous default of 1 to prove reclaimable-starvation handling now pin
  `PROJECT_DATA_ARCHIVE_SWEEP_SESSIONS='1'` explicitly and were renamed accordingly.

## Review findings fixed before merge (2026-09-05, Phase 5)

- **Abandon race (CRITICAL, cloudflare-specialist + security-auditor).** The first cut deleted the
  shard copy before the lock-protected source abandon, trusting a point-in-time
  `inspectSourceIntent` read. A sweep whose lease had expired but which was still mid-finalize could
  delete the source in that window, leaving zero copies while D1 reported `published`. Fix:
  `reserveAbandonLease` (D1 CAS, epoch bump, same predicate family as `claimMigrationLease`) runs
  before any object call; `archiveSourceAbandonIntent` (root transcript lock, refuses once the
  payload is gone, and removes the intent finalize requires) runs BEFORE
  `archiveTargetAbandonSession`; the reservation is released if a step throws; the D1 freeze is
  guarded by the reserved epoch. Class of bug: cross-object check-then-act with the destructive
  step on the wrong side of the only serialization point (rules 45/58). Tests: `never drops the
shard copy when the source is finalized between the inspect read and the abandon` (fails with
  target-first ordering), `fences the journal before touching any object` (fails without the CAS),
  reservation-takeover with a live-worker control.
- **Fence-before-process (HIGH, performance-reviewer).** With the ceiling at 10, the sweep journaled
  every candidate (fencing it `migrating`) up front and only then checked wall time between
  migrations, so a 5 s tick could leave up to nine sessions unreadable until the next 24 h sweep.
  Fix: `selectMigrationWork` returns unjournaled `pending` candidates; `processArchiveMigrationBatch`
  checks wall time, journals, and processes one candidate at a time. Test: `leaves sessions it never
reached unfenced when wall time runs out mid-tick` (fails against eager journaling).
- **Per-page sort (HIGH, performance-reviewer).** `forEachGroupedRowPaged` seeked by `rowid`, which
  no index serves on `chat_messages_grouped`; SQLite planned a temp b-tree over the whole remaining
  session on every page (measured O(N²/page): 200k rows ≈ 4.5 s). Fix: seek on the indexed
  `(created_at, id)` order and still select `rowid` for the FTS delete markers. Test: `EXPLAIN QUERY
PLAN` on `GROUPED_ROW_PAGE_SQL` asserts the index range scan and no full-sort step, with the
  rejected rowid shape as a control.
- Also addressed: `abandon_reason_required` mapped to 400 plus a route-level test; env clamp tests
  for `PROJECT_DATA_ARCHIVE_HASH_PAGE_ROWS`; abandon paging bound test on a 1,205-row shard copy;
  `state !== 'failed'` lease disjunct test; selection tie-break determinism test.
- Deferred (documented, non-blocking): splitting the two >2,500-line modules (rule 18, pre-existing
  exceptions); a `session_summaries` index for the terminal-session candidate scan (pre-existing,
  global sweep is cadence-gated to once per interval); a real-middleware auth integration test for
  admin routes (repo-wide pattern).
