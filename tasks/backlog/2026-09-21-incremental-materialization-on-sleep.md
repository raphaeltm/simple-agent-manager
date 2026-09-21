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

- [ ] Migration `057-chat-search-incremental-watermark` — two additive columns + probe SELECT
- [ ] `row-schemas/materialization.ts` — extend the session-state schema, add a token schema with `sequence`, add a trailing-grouped-row schema
- [ ] `materialization.ts` — watermark resolution, bounded token scan, trailing-group extension, `partial`/`complete` stamping, `grouped_fts_pruned` refusal
- [ ] `materialization.ts` — sweep predicate + remaining count rewritten around the watermark; rename `materializeAllStopped` -> `materializePendingSessions` (it no longer covers only stopped sessions)
- [ ] `index.ts` — materialize inside `sleepSession()`; rename the RPC wrapper
- [ ] `services/project-data.ts` — rename the service wrapper to match
- [ ] `grouped-fts-cleanup.ts` — clear the watermark columns when pruning
- [ ] `messages.ts` — LIKE fallback gated on the watermark instead of `materialized_at IS NULL`
- [ ] Tests: sleep -> wake -> write -> sleep, both batches searchable (load-bearing, real trigger)
- [ ] Tests: final-stop captures the post-last-sleep tail
- [ ] Tests: boundary run is one grouped row, searchable across the boundary
- [ ] Tests: idempotent second sleep with no new messages
- [ ] Tests: rows-read assertion proving pass 2 does not re-scan batch 1 (drives the real `sleepSession`)
- [ ] Tests: legacy row (`materialized_at` set, watermark NULL) does not duplicate content
- [ ] Tests: pruned session is refused and stays LIKE-searchable
- [ ] Tests: live tail still LIKE-searchable after the session was materialized once
- [ ] Prove discriminating: revert the watermark to the old boolean gate, confirm exactly the sleep-wake-sleep test reddens, restore
- [ ] `pnpm lint && pnpm typecheck && pnpm test && pnpm build`
- [ ] Specialist review (task-completion-validator, cloudflare-specialist, performance-reviewer, architecture-reviewer, test-engineer)
- [ ] Staging deploy + live verification (sleep, wake, write, search both halves)
- [ ] PR, CI, CodeRabbit, merge, production deploy monitoring

## Acceptance criteria

- [ ] A session that sleeps has its assistant text findable by `search_messages` before it ever stops
- [ ] After sleep -> wake -> more messages -> sleep, **both** batches are findable
- [ ] Final stop still indexes anything written after the last sleep
- [ ] Running materialization twice with no new messages performs no writes
- [ ] A same-role run spanning a sleep boundary yields one grouped row, and a phrase spanning the
      boundary is findable
- [ ] Rows read by the second pass is proportional to new messages, not total session size, proven
      by an assertion driving the real `sleepSession()` path
- [ ] The `COALESCE(origin,'user') != 'system'` search filter does not leak into any message read path
- [ ] Storage-relief pruning still wins: a pruned session is never re-materialized and stays
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
