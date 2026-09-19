-- Sidebar ordering: sort by the last REAL message time, not `updated_at`.
--
-- `updated_at` doubles as the DO→D1 delta-sync watermark (the sync only
-- re-mirrors rows with `updated_at >= synced_at`), so lifecycle transitions
-- bump it long after the last message: the sleep-snapshot purge sweep stops
-- 7-day-old sleeping sessions and the terminal-ledger repair terminalizes
-- stale active rows, each stamping `updated_at = now`. Ordering on it
-- resurrected those sessions at the top of the sidebar as "just now"
-- (production evidence: 117 sessions, 115 with an exactly 7.0-day gap).
--
-- The read side now orders by COALESCE(last_message_at, updated_at); these
-- migrations complete the column and index the expression.

-- Backfill: complete the sort key for legacy rows. `last_message_at` has been
-- synced since 0049 but could be NULL for sessions with no messages; those
-- order by their `updated_at` (== creation time for an untouched session).
UPDATE session_summaries
   SET last_message_at = COALESCE(last_message_at, updated_at)
 WHERE last_message_at IS NULL;

-- Expression indexes matching the read-side sort exactly:
--  - project-scoped: the per-project sidebar fast path
--    (services/session-summary-index.ts).
--  - user-scoped: the cross-project /api/chats and /api/chats/recent lists.
CREATE INDEX idx_session_summaries_project_last_message
  ON session_summaries(project_id, COALESCE(last_message_at, updated_at) DESC);

CREATE INDEX idx_session_summaries_user_last_message
  ON session_summaries(user_id, COALESCE(last_message_at, updated_at) DESC);
