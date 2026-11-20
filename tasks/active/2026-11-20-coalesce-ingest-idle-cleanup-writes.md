# Coalesce the idle-cleanup deadline extension on chat ingest

SAM task `01M7W2DZ0EM364H7QSF7PXKW3C`. Item D of idea `01M7CX61WVX72T7CFQNRTX0DVM`.

## Problem

Raphaël, 2026-11-20: "Start it. Get it tested in staging." (merge to production not yet
authorized). Chat ingest (`persistMessageBatch`) is about 44% of the ProjectData Durable Object
rows written in production (2026-11-19 readout, ~14.6 writes per call). Most of a batch's writes
are bookkeeping, not messages.

Measured locally in real workerd (merged single-row assistant batch, prompting turn, idle-cleanup
schedule armed — the production shape), each batch writes 12 rows:

| Statement                                                                | Rows |
| ------------------------------------------------------------------------ | ---: |
| `chat_messages` append                                                   |    1 |
| `chat_sessions` counters + `updated_at` (3 indexes include `updated_at`) |    4 |
| `idle_cleanup_schedule` deadline extension (`resetIdleCleanup`)          |    3 |
| `session_state` activity/work clocks                                     |    2 |
| `workspace_activity` upsert                                              |    1 |
| native alarm re-arm (`recalculateAlarm`)                                 |    1 |

The idle-cleanup extension and the alarm re-arm it triggers (4 of 12) run on every batch, although
the deadline moves by only a few seconds each time against a 15-minute timeout.

## Research findings

- `resetIdleCleanup()` (`packages/project-data/src/do/idle-cleanup.ts`) rewrites `cleanup_at`,
  `retry_count`, `last_error` whenever a schedule is armed; `cleanup_at` is indexed, so 3 rows.
  The batch path then calls `recalculateAlarm()` (1 native alarm write).
- Callers: batch ingest (`persistMessageBatchWithSideEffects`), single-message persist
  (`runPersistedMessageSideEffects`), accepted prompt delivery (`durability-foundation.ts`). Only
  the batch path is hot; the others are once per human/delivered prompt and stay exact.
- Readers of `cleanup_at`: `processExpiredCleanups` (`cleanup_at <= now`, and
  `idleDurationMs = now - (cleanup_at - timeout)` for diagnostics), `computeIdleCleanupAlarmTime`,
  session list (`session-reads.ts`, displayed countdown).
- Condition vs signal (rule 74): the condition is "no message for the idle timeout"; the signal
  is `cleanup_at`. Coalescing must never make cleanup fire before `last message + timeout`.
  Design: when the stored deadline already covers `now + timeout`, skip the write; when it does
  not, write `now + timeout + interval`. Cleanup is therefore never early and at most `interval`
  late. A schedule in retry (`retry_count > 0` or `last_error`) is always rewritten, as today.
- Rejected for this change (state in PR):
  - `chat_sessions.updated_at`: the D1 summary delta (`SESSION_SUMMARY_DELTA_SQL`) depends on
    every write advancing it; widening its floor would re-upsert active sessions to D1 on every
    5 s sync, costing more D1 writes than the DO writes saved.
  - `workspace_activity.last_message_at`: read by task reconciliation as last activity with a
    5-minute idle threshold; a stale value moves checks earlier.
  - `session_state` clocks: read by the probe CAS, the sleep idle clock and the stale-turn bound.
- Tunables go in the admin settings registry (rule 07). The batch path already resolves the chat
  ingest settings through `projectDataPorts().operations.messageMergeConfig`; the interval joins
  that config (`MessageMergeConfig`), default in `DEFAULT_MESSAGE_MERGE_CONFIG`.

## Implementation checklist

- [ ] `resetIdleCleanup(sql, env, sessionId, options?)`: optional `extendIntervalMs` (absent or 0 =
      today's exact behaviour); skip when the armed, non-retrying deadline already covers
      `now + timeout`; otherwise write `now + timeout + interval`. Report whether it wrote.
- [ ] Batch path passes the configured interval and recalculates the alarm only after a write.
- [ ] `MessageMergeConfig.idleExtendIntervalMs` + default (60 s) in `DEFAULT_MESSAGE_MERGE_CONFIG`.
- [ ] Admin setting `chat.idleCleanupExtendIntervalMs` (0–300000), resolved in `operationsPort`.
- [ ] Tests (real workerd, real RPC): steady batches within the interval write no idle rows and
      no alarm; a batch after the interval extends; deadline never earlier than
      `last message + timeout`; retry state still reset; interval 0 restores per-batch writes;
      single-message and prompt-delivery paths unchanged; row-cost profile snapshot updated.
- [ ] Discrimination: remove the skip, confirm the coalescing tests go red.
- [ ] Docs: admin settings guide / any doc describing idle cleanup extension.

## Acceptance criteria

- [ ] A steady merged batch inside the interval writes 4 fewer rows (idle 3 + alarm 1) in real workerd.
- [ ] Idle cleanup never fires before `last message + timeout`; at most `interval` later.
- [ ] Setting the interval to 0 restores the per-batch extension exactly.
- [ ] Staging: measured `persistMessageBatch` writes per call before and after on a real agent
      chat, and the idle cleanup still fires for an idle task session.
- [ ] Raphaël asked via inbox before merge (merge not authorized yet).
