# Fix sidebar session ordering: use last_message_at, not updated_at

## Problem

Old sessions reappear at the top of the project sidebar session list showing
"just now" even though their last real message is 7+ days old.

Production evidence (14-day window): 117 sessions were bumped >2 days past
their last message; 115/117 show exactly a 7.0-day gap matching
`SESSION_SNAPSHOT_TTL_DAYS`; all 117 are `stopped` with `ended_at = updated_at`.

## Root cause

The sleep-snapshot purge sweep (`apps/api/src/scheduled/d1-retention.ts:454`)
finds expired sleeping sessions after the 7-day TTL and calls
`projectDataService.stopSession()`. That calls `terminateSession()` in
`apps/api/src/durable-objects/project-data/sessions.ts:305`, which stamps
`updated_at = Date.now()`. The next summary sync mirrors the row to D1
`session_summaries`, and because every read path sorts by `updated_at`, the
session jumps to the top of the sidebar.

A secondary contributor is `terminalizeSummary()` in
`apps/api/src/scheduled/session-summary-ledger-reconciliation.ts:253`, which
sets `updated_at = nowMs` directly on D1 `session_summaries`.

`updated_at` cannot simply stop being bumped: it is also the delta-sync
watermark (`session-summary-sync.ts` only re-mirrors rows with
`updated_at >= syncedAt`), so lifecycle stops must keep bumping it or the D1
index would never learn a session is stopped.

## Fix strategy (read side)

`session_summaries` already carries a real `last_message_at` column
(archive-aware, populated by `session-summary-sync.ts`). The DO
`chat_sessions` table does NOT carry a live per-session last-message column —
only `archive_last_message_at` (set at archive time). So the fix has two
halves:

1. **DO: maintain `chat_sessions.last_message_at`** (new column, migration
   057) — set at creation, bumped by `persistMessage`/`persistMessageBatch`
   for non-`system` roles only (the idle-cleanup notice is persisted as a
   `system`-role message and must NOT bump it), backfilled from
   `COALESCE(archive_last_message_at, MAX(chat_messages.created_at) where
   role != 'system', started_at)`.
2. **Read paths order by `COALESCE(last_message_at, updated_at) DESC`** and map
   `lastMessageAt` from `last_message_at` (falling back to `updated_at`).

## Research findings

- D1 sidebar query: `apps/api/src/services/session-summary-index.ts:230`
  (`ORDER BY updated_at DESC`), row mapper `:139` (`lastMessageAt:
  row.updated_at`). A doc comment there explicitly documents the old
  load-bearing behavior — must be inverted.
- DO list path: `apps/api/src/durable-objects/project-data/sessions.ts:461`
  (`listSessions` ORDER BY updated_at) and `getSessionsByTaskIds` (`:534`),
  row mapper `apps/api/src/durable-objects/project-data/row-schemas/sessions.ts:45`.
- Cross-project routes: `apps/api/src/routes/chats.ts` — `/api/chats/recent`
  sorts AND stale-filters on `updated_at`; `/api/chats` sorts on `updated_at`.
- Sync: `apps/api/src/durable-objects/project-data/session-summary-sync.ts`
  derives D1 `last_message_at` as `COALESCE(archive_last_message_at, (SELECT
  MAX(created_at) FROM chat_messages ...))` — NO role filter, so the
  idle-cleanup system notice currently bumps D1 `last_message_at` too (edge
  case confirmed real: `persistSystemMessage` in
  `project-data/messages.ts:663` inserts role='system' and bumps
  `chat_sessions.updated_at`).
- D1 `session_summaries` indexes (`apps/api/src/db/schema.ts:3244-3262`):
  `(project_id, updated_at)`, `(user_id, status, updated_at)`,
  `(project_id, created_by_user_id, updated_at)`, terminal-reconcile — none
  cover a `COALESCE(last_message_at, updated_at)` sort.
- `terminalizeSummary()` writes `updated_at` but does NOT touch
  `last_message_at` — already safe once ordering changes; add a regression
  test.
- Writers of D1 `session_summaries` (rule 44 enumeration): sync upsert
  (`session-summary-sync.ts`), admin backfill (`routes/admin.ts:366`),
  `terminalizeSummary`/`deferCandidate` (ledger reconciliation),
  `session-task-reconciliation.ts:48` (task_id only). None clobber
  `last_message_at` except the sync, which we are updating.
- Writers of DO `chat_sessions` timestamps (rule 44 enumeration):
  `createSession`, `createReservedTaskSession`, `linkSessionToTask`,
  `terminateSession`, `sleepSession`, `wakeSession`,
  `linkSessionToWorkspace`, `updateSessionTopic`, `markAgentCompleted`,
  `insertNewMessage`, `persistMessageBatch`, `persistSystemMessage`,
  archive-sharding (`archive_last_message_at` only). Lifecycle writers keep
  bumping `updated_at` (watermark) and leave `last_message_at` alone.
- DO migrations already use expression indexes (migration 054 uses
  `json_extract` in an index), so `COALESCE(...)` expression indexes are
  safe in DO SQLite; D1 runs the same SQLite engine.
- Tests: `tests/unit/services/session-summary-index.test.ts` (real
  better-sqlite3 engine), `tests/unit/routes/chats.test.ts` (mock D1),
  `tests/unit/durable-objects/project-data-sessions-list.test.ts` (fake
  SqlStorage), `tests/unit/durable-objects/session-summary-sync.test.ts`,
  `tests/unit/durable-objects/migrations.test.ts` (asserts CREATE INDEX
  count = 125 — must be bumped).

## Implementation checklist

- [ ] DO migration `057-chat-sessions-last-message-at`: add column, backfill,
      expression index `COALESCE(last_message_at, updated_at) DESC`
- [ ] DO writers: init `last_message_at` at session creation; bump on
      non-system message persist (single + batch); leave alone for
      `persistSystemMessage` and all lifecycle writers
- [ ] DO reads: `listSessions`, `getSessionsByTaskIds`, `getSession` select
      the column; list ordering `COALESCE(last_message_at, updated_at) DESC`;
      row mapper `lastMessageAt` from `last_message_at ?? updated_at`
- [ ] Sync: derive `last_message_at` from the maintained column with the
      legacy fallback chain (incl. `role != 'system'` filter)
- [ ] D1 index read (`session-summary-index.ts`): SELECT + valibot schema +
      mapper + `ORDER BY COALESCE(last_message_at, updated_at) DESC`; update
      the load-bearing doc comment
- [ ] `chats.ts`: ordering + `/recent` staleness predicate on
      `COALESCE(last_message_at, updated_at)`
- [ ] D1 migration `0165_session_summaries_last_message_order.sql`: backfill
      NULL `last_message_at` rows; expression indexes for project- and
      user-scoped sorts; mirror in `db/schema.ts`
- [ ] `admin.ts` backfill route keeps working with the new mapper (writes
      non-null `last_message_at`)
- [ ] Tests: ordering regression (stopped session with recent `updated_at`
      stays below a session with a newer `last_message_at`); system-message
      exclusion; batch/single writer behavior; sync derivation; migration
      backfill; terminalize preserves `last_message_at`; update index-count
      test
- [ ] Verify `terminalizeSummary()` still does not overwrite
      `last_message_at` (comment + regression test)

## Acceptance criteria

1. A session terminated by the sleep-snapshot purge sweep does NOT reappear
   at the top of the project sidebar; it stays ordered by its last real
   message time.
2. The D1 fast path and the DO fallback path agree on ordering and
   `lastMessageAt` (both derive from `last_message_at` with `updated_at`
   fallback).
3. The idle-cleanup `system` notice does not bump ordering position.
4. `updated_at` continues to be bumped by lifecycle stops (delta-sync
   watermark preserved).
5. Full quality suite green; staging verification shows correct ordering
   end-to-end.

## References

- Task 01M2VR2EJR0ZXJG6D4V249W3S8 (investigation), this fix executes under
  SAM task 01M2X10Y8QSJSXP7SDZ4JCCJEP, branch
  `sam/fix-old-sessions-reappearing-jccjep`.
- `.claude/rules/31-migration-safety.md`, `44-dual-write-migration-enumerate-writers.md`,
  `50-list-read-row-fault-isolation.md`, `51-runtime-boundary-validation.md`
