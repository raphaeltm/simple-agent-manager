# Incremental watermark-based session materialization on sleep

**SAM task**: `01M311HVPP9WKMJAGWEAGVZQQ4`
**Branch**: `sam/sleeping-sam-chat-sessions-gvzqq4`

## Problem

Assistant text in SAM chat is unsearchable at any age. Reproduced 2026-09-21 in session
`7cbf23a0-72c2-4183-a48d-951a1dbc258f`: `search_messages(query="vestigial", roles=["assistant"])`
returned 0 results for a word written twice in that session ~20 minutes earlier. Control in the
same session: `search_messages(query="dispatched", roles=["user"])` returned 1 correct hit.

Root cause: every streaming token is its own `chat_messages` row (measured 2026-09-11: 239 of 255
rows, p50 content length 4 chars). No row contains a whole word, so keyword matching cannot hit.
`materializeSession()` builds the grouped, searchable text, but it only runs on session **stop**
(`project-data/index.ts:394`), **fail** (`:498`) and idle-cleanup terminalization
(`idle-cleanup.ts:373`, `:574`). Sleeping and live sessions are never indexed, and most recent
sessions are sleeping, not stopped.

## The trap (do not implement the one-liner)

Adding `materializeSession()` to `sleepSession()` without changing the function makes search
**worse** than today:

1. `materializeSession()` early-returns when `materialized_at IS NOT NULL` (`materialization.ts:34`).
2. It rebuilds from ALL tokens for the session, with no watermark (`:35-41`).

So: first sleep indexes and stamps `materialized_at`; the session wakes and writes thousands more
token rows; the second sleep hits the early return and does nothing; final stop ALSO hits the early
return. Everything after the first wake becomes permanently unsearchable. The backfill sweep does
not rescue it either — `materialization.ts:125` selects `status='stopped' AND materialized_at IS NULL`.

Failure class: `.claude/rules/62` (sticky state making a later path unreachable) and
`.claude/rules/73` (a default that deletes state).

## Research findings

### Current state

| Fact | Location |
|---|---|
| `materializeSession()` boolean gate + full rebuild | `apps/api/src/durable-objects/project-data/materialization.ts:27-113` |
| Backfill sweep predicate + remaining count | `materialization.ts:119-153` |
| `sleepSession()` DO entry point (no materialization) | `project-data/index.ts:417-424` |
| `stopSession` / `failSession` materialize | `index.ts:394`, `index.ts:498` |
| Idle cleanup materializes on terminalization | `idle-cleanup.ts:373`, `:574` |
| FTS search path | `project-data/messages.ts:482-565` |
| LIKE fallback, gated on `s.materialized_at IS NULL` | `messages.ts:567-610` (`onlyNonMaterialized`) |
| Token index `(session_id, created_at, sequence)` | `migrations.ts:476` (`idx_chat_messages_session_seq`) |
| `chat_messages.sequence` is monotonic per session | `messages-persist-helpers.ts:33` |
| Grouped/FTS tables + `materialized_at` column | `migrations.ts:555-599` (migration `011`) |
| `search_index_state/updated_at/degradation_reason` | `migrations.ts:1644-1662` (migration `042`) |
| Terminal DO statuses are `stopped` / `failed` | `sessions.ts:361-385`, `grouped-fts-cleanup.ts:155` |
| Latest DO migration is `056-...` | `migrations.ts:2206` |

### Other writers of the materialization state (rule 44 — enumerate every writer)

1. **`grouped-fts-cleanup.ts:229-241`** — storage relief deletes every grouped/FTS row for a terminal
   session, sets `materialized_at = NULL` and `search_index_state = 'grouped_fts_pruned'`, and relies
   on the raw-message LIKE fallback thereafter. A watermark left behind here would (a) let a later
   pass believe indexed content still exists, and (b) exclude the session's raw rows from the LIKE
   fallback. **Must clear the watermark there, and `materializeSession` must refuse pruned sessions.**
   Pinned by `project-data-storage-safety.test.ts:1102-1107` which asserts search still finds the
   session after pruning.
2. **`archive-sharding.ts:66-85`** — `CHAT_SESSION_ANCHOR_COLUMNS` is copied to the target DO **and**
   feeds a SHA-256 archive proof (`archive-sharding.ts:883`). Adding columns changes that hash, which
   is a rolling-deploy hazard for an in-flight archive. Decision: **do not touch the anchor list**;
   instead `materializeSession` derives a legacy watermark from `materialized_at` when the watermark
   columns are NULL, which is exact for terminal sessions (the only kind that archive).
3. **`storage-relief-measurement.ts:162`** — reads `search_index_state` only to exclude
   `grouped_fts_pruned`. A new `'partial'` value is safe there.
4. `search_index_state` has **no** API/UI consumer (verified by grep across `apps/`, `packages/`).

### Regression the fix itself would introduce (must be handled)

`searchMessagesLike(onlyNonMaterialized=true)` currently means *"only sessions that were never
materialized"*. Once sleeping sessions are stamped, a woken session's **live tail** (text written
after the last sleep) would be dropped from the LIKE fallback — text that is findable today. The
predicate must become *"only rows past the session's materialization watermark"*, which preserves
the existing de-duplication property (no row can appear in both the FTS and LIKE result sets) while
keeping the live tail reachable.

### Cost

DO `rowsRead` is the only line that has ever cost real money on this account (~$32, August 2026).
A full rebuild per sleep is O(total session tokens) per sleep — quadratic over a session's life.
Target: O(new tokens) per pass.

## Design

**Watermark columns** (new DO migration `057`, additive `ALTER TABLE ADD COLUMN`, rule 31):

- `chat_sessions.materialized_through_created_at INTEGER`
- `chat_sessions.materialized_through_sequence INTEGER`

**Effective watermark** (handles pre-watermark rows and archived rows with no watermark):

```
createdAt = materialized_through_created_at ?? materialized_at
sequence  = materialized_through_sequence  ?? +infinity
```

Pre-watermark code only ever materialized *everything that existed* at `materialized_at`, and
`materialized_at = Date.now()` is stamped after the read, so `materialized_at >= max(token.created_at)`.
Treating `(materialized_at, +inf)` as the watermark therefore re-reads nothing and skips nothing.

**Token scan** (index-friendly, NULL-safe):

```sql
SELECT id, role, content, created_at, sequence
FROM chat_messages
WHERE session_id = ?
  AND COALESCE(origin, 'user') != 'system'
  AND created_at >= ?
  AND (created_at > ? OR COALESCE(sequence, 0) > ?)
ORDER BY created_at ASC, sequence ASC
```

`created_at >= ?` is a range scan on `idx_chat_messages_session_seq(session_id, created_at, sequence)`.

**Boundary group**: a run of same-role groupable tokens that spans a materialization boundary is
**extended in place**, not split. The pass reads the trailing grouped row for the session; if its
role matches the first new token's role and the role is groupable, the leading new run is appended
to that row's content (`UPDATE chat_messages_grouped`, plus an FTS5 external-content
delete-marker + re-insert, the same primitive `grouped-fts-cleanup.ts:214` already uses).

**State** (reuse existing columns, no new state vocabulary):

- `search_index_state = 'complete'` — terminal session, everything indexed
- `search_index_state = 'partial'` — non-terminal session, indexed through the watermark
- `search_index_state = 'grouped_fts_pruned'` — unchanged; `materializeSession` refuses these

**Idempotency**: no new tokens and no state promotion => zero writes and one row read.

**Sweep predicate**: `materialized_at IS NULL` is replaced by "has at least one non-system message
past the watermark, and is not pruned", bounded by an examination cap.

**Hook**: `ProjectData.sleepSession()` only, guarded on `sessions.sleepSession()` returning true.
Not on wake: a wake is latency-sensitive and adds no new text, and the next sleep indexes the same
content plus the tail, so materializing on wake would double the passes for zero search benefit.

## Implementation checklist

- [x] Migration `057-chat-search-incremental-watermark` — two additive columns + probe SELECT
- [x] `row-schemas/materialization.ts` — extend the session-state schema, add a token schema with `sequence`, add a trailing-grouped-row schema
- [x] `materialization.ts` — watermark resolution, bounded token scan, trailing-group extension, `partial`/`complete` stamping, `grouped_fts_pruned` refusal
- [x] `materialization.ts` — sweep predicate + remaining count rewritten around the watermark; rename `materializeAllStopped` -> `materializePendingSessions` (it no longer covers only stopped sessions)
- [x] `index.ts` — materialize inside `sleepSession()`; rename the RPC wrapper
- [x] `services/project-data.ts` — rename the service wrapper to match
- [x] `grouped-fts-cleanup.ts` — clear the watermark columns when pruning
- [x] `messages.ts` — LIKE fallback gated on the watermark instead of `materialized_at IS NULL`
- [x] Tests: sleep -> wake -> write -> sleep, both batches searchable (load-bearing, real trigger)
- [x] Tests: final-stop captures the post-last-sleep tail
- [x] Tests: boundary run is one grouped row, searchable across the boundary
- [x] Tests: idempotent second sleep with no new messages
- [x] Tests: rows-read assertion proving pass 2 does not re-scan batch 1 (drives the real `sleepSession`)
- [x] Tests: legacy row (`materialized_at` set, watermark NULL) does not duplicate content
- [x] Tests: pruned session is refused and stays LIKE-searchable
- [x] Tests: live tail still LIKE-searchable after the session was materialized once
- [x] Prove discriminating: revert the watermark to the old boolean gate, confirm exactly the sleep-wake-sleep test reddens, restore
- [x] Tests: a replayed pass over groups that already exist does not corrupt the index
- [x] Page the token scan and bound the per-pass row budget (DO isolate memory ceiling, rule 69)
- [x] Row-value tuple seek so a same-millisecond cluster is not re-walked per pass
- [x] Checkpoint the watermark immediately after a boundary extension (extension is not idempotent)
- [x] Cap grouped-row growth so a repeatedly-extended run is not O(k^2) in bytes rewritten
- [x] Fix the four stale doc locations describing the old stop-only indexing
- [ ] `pnpm lint && pnpm typecheck && pnpm test && pnpm build`
- [x] Specialist review (7 reviewers: task-completion-validator, cloudflare-specialist, performance-reviewer, architecture-reviewer, test-engineer, constitution-validator, doc-sync-validator)
- [ ] Staging deploy + live verification (sleep, wake, write, search both halves)
- [ ] PR, CI, CodeRabbit, merge, production deploy monitoring

## Acceptance criteria

- [x] A session that sleeps has its assistant text findable by `search_messages` before it ever stops
- [x] After sleep -> wake -> more messages -> sleep, **both** batches are findable
- [x] Final stop still indexes anything written after the last sleep
- [x] Running materialization twice with no new messages performs no writes
- [x] A same-role run spanning a sleep boundary yields one grouped row, and a phrase spanning the
      boundary is findable
- [x] Rows read by the second pass is proportional to new messages, not total session size, proven
      by an assertion driving the real `sleepSession()` path
- [x] The `COALESCE(origin,'user') != 'system'` search filter does not leak into any message read path
- [x] Storage-relief pruning still wins: a pruned session is never re-materialized and stays
      LIKE-searchable

## References

- `.claude/rules/62-tests-must-observe-the-real-trigger.md`
- `.claude/rules/73-optional-struct-fields-must-not-overwrite-on-absence.md`
- `apps/api/.claude/rules/31-migration-safety.md`
- `apps/api/.claude/rules/44-dual-write-migration-enumerate-writers.md`
- `apps/api/.claude/rules/45-durable-object-concurrency-mutex.md`
- `apps/api/.claude/rules/47-control-loop-io-budget.md`
- Out of scope: idea `01M2Z46ZFZZYB72EDHWNREEESE` (project-wide archive search owner cap),
  idea `01M27M6BDJCRVE1FFQA5BXAQ5D` (server-side delta grouping on the chat READ path)


## Implementation notes

### Discrimination results (rule 62)

Each guard was reverted in isolation and the suite re-run. Every revert was surgical
(the code still compiled), and the code was restored immediately after.

| Reverted guard | Tests that went red |
|---|---|
| `materializeSession` early-returns on `materialized_at IS NOT NULL` (the old boolean gate) | 6 — sleep/wake/sleep (**the load-bearing one**), final-stop tail, boundary run, role-change boundary, rows-read, legacy watermark |
| Boundary extension disabled (`extendTrailingGroup` never called) | 3 — boundary run, rows-read, legacy watermark |
| `grouped-fts-cleanup` stops clearing the watermark columns | 1 — pruned session (both the column assertions and, verified separately with those relaxed, the rebuild assertions) |
| LIKE fallback reverted to `s.materialized_at IS NULL` | 1 — woken-session live tail (`expected 0 to be greater than or equal to 1`) |
| Token scan ignores the watermark (full rebuild every pass) | 5 — boundary run, role-change boundary, idempotency, rows-read (`expected 64 to be less than or equal to 5`), legacy watermark |

One check did NOT discriminate, and the code comment was corrected rather than the
claim kept: replacing `ON CONFLICT(id) DO NOTHING RETURNING rowid` with the older
`INSERT OR IGNORE` + `SELECT rowid` left all 11 tests green. A direct workerd probe
confirmed why — inserting a duplicate rowid into this external-content FTS5 table
neither errors nor produces a duplicate `MATCH` hit. The `RETURNING` form is kept for
the read it saves per group, and its comment now says exactly that.

### Read amplification

Per pass, rows read is `1 (session state) + N (new tokens) + 1 (trailing grouped row)
+ 0`, where N is the number of non-system messages written since the last pass. The
grouped-row insert no longer costs a read per group. Measured in
`project-data-incremental-materialization.test.ts`: with a 60-token first batch and a
4-token second batch, the second `sleepSession()` reads **at most 5** rows from
`chat_messages` and fewer than 60 rows in total across the whole sleep path. A full
rebuild reads 64.

### Decisions taken

- **Not materializing on wake.** A wake is latency-sensitive and adds no new text; the
  next sleep indexes the same content plus its tail, so a wake-time pass would double
  the passes for zero search benefit.
- **`CHAT_SESSION_ANCHOR_COLUMNS` left unchanged.** That list feeds a SHA-256 archive
  proof (`archive-sharding.ts:883`), so adding columns to it is a rolling-deploy hazard
  for an in-flight archive. It already carries `materialized_at`, and archived sessions
  are terminal, so the legacy fallback in `resolveWatermark()` reconstructs an exact
  watermark for them. Covered by the legacy-watermark test.
- **A pruned session is never re-indexed.** Previously, `grouped-fts-cleanup` set
  `materialized_at = NULL`, so a pruned session that was later re-stopped would be fully
  re-materialized — silently undoing the storage relief. `search_index_state =
  'grouped_fts_pruned'` is now a hard refusal. The session stays LIKE-searchable, which
  is exactly what its stored `search_index_degradation_reason` already promises.
- **The sweep has no automatic caller.** `materializePendingSessions` is reachable only
  by RPC; nothing schedules it. Sessions already asleep before this ships become
  searchable when they next sleep or stop. Wiring a periodic backfill is deliberately
  left out of this change — it needs its own I/O budget, config, and tests under
  rule 47 — and is filed as idea `01M313TT05Q5R09D9E0ZZGW0E3`, referenced from a comment
  on `materializePendingSessions`.


## What specialist review changed

Seven local reviewers ran. None of the findings below were in the original design; all were
implemented before staging.

| Finding | Severity | Fix |
|---|---|---|
| Unbounded `SELECT ... WHERE session_id = ?` + `toArray()` on a never-indexed session, now reachable from the frequent `sleepSession` trigger rather than only from `stop`. Same shape that reset this DO's isolate twice on 2026-09-05 (rule 69). | CRITICAL (found independently by 3 reviewers) | Paged the scan (`PROJECT_DATA_MATERIALIZATION_PAGE_ROWS`, default 500) with a per-pass row budget (`..._MAX_ROWS_PER_PASS`, default 5000). A truncated pass stays `partial` with an advanced watermark and resumes next time. |
| The scan re-walked every row tied at the watermark's `created_at`: measured **201 rows re-read** for a 200-token burst sharing one timestamp. My comment claimed it "only re-filters the boundary millisecond". | HIGH | Replaced `created_at >= ? AND (created_at > ? OR sequence > ?)` with the SQLite row-value form `(created_at, sequence) > (?, ?)`, which seeks INSIDE the millisecond. Now ≤2 rows, with a test that forces the collision. |
| `extendTrailingGroup` is a plain in-place `UPDATE` with no conflict guard, and every caller catches-and-logs. A throw between the extension and the end-of-pass watermark stamp would make the retry append the same text twice. | HIGH | Checkpoint the watermark immediately after an extension, before the rest of the page. |
| The sweep's `EXISTS` probe was O(session history) per candidate, not the "one indexed lookup" the comment claimed (measured 5,000 rows visited per already-indexed 5,000-message candidate). | HIGH | Same row-value seek; comment corrected to state the real cost, including that `scanLimit` bounds probes and materialization but NOT `chat_sessions` rows read. |
| `chat_messages.created_at` is the VM agent's own clock and it retries delivery for up to 5 minutes, while `sleepSession()` runs before the workspace stops. A retried batch can land below the watermark and never be indexed. | HIGH | Watermark now advances by `MAX(created_at)`/`MAX(sequence)`; the LIKE fallback gained a `sequence` arm so late arrivals stay findable; regression test drives the real `persistMessageBatch` path. The residual streaming-assistant case (4-char tokens can't satisfy a keyword LIKE) is idea `01M315GZ5P6QGSHM6CB730PMR9`. |
| Extending a run rewrites the whole accumulated content plus both FTS postings, so k extensions of a growing turn cost O(k²) bytes. | MEDIUM | `PROJECT_DATA_MATERIALIZATION_MAX_GROUP_CHARS` (default 65536): past that a continuation starts a new grouped row. |
| `replaceFtsRow`'s delete+insert pair can fail halfway, leaving a grouped row with zero postings — silent and permanent. | MEDIUM | Logged rather than swallowed with the missing-table case. |
| Four docs still described indexing as happening only "when a session ends", including the MCP `search_messages` tool description that agents read. | MEDIUM ×4 | All four rewritten to describe the incremental model, with code citations. |
| The new `SEARCH_INDEX_STATE_*` constants weren't used by the two existing files that write/read the same literals. | LOW/MEDIUM | Consolidated in `grouped-fts-cleanup.ts` and `storage-relief-measurement.ts`. |
| Idempotency test asserted value-equality rather than zero writes; no coverage for `failSession`, `tool`/`thinking` roles, an empty session, or a system-origin message mid-run. | LOW/MEDIUM | All added; the idempotency test now counts writes through the SQL probe. |

### Known gaps, deliberately not closed here

- **The sweep has no automatic caller** (idea `01M313TT05Q5R09D9E0ZZGW0E3`). Sessions already asleep
  when this ships become searchable when they next sleep or stop. Wiring a periodic caller needs a
  partial index on the non-pruned rows first, because `scanLimit` does not bound the `chat_sessions`
  scan when pruned rows dominate.
- **Out-of-order batch arrival for streaming assistant tokens** (idea `01M315GZ5P6QGSHM6CB730PMR9`).
- **Idle-cleanup's two `materializeSession` call sites have no test.** Pre-existing; the wiring is
  unchanged by this PR and both now pass the resolved pass config like every other call site.
