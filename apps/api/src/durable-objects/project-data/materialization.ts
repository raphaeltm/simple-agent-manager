/**
 * Message materialization — grouping streaming tokens and FTS5 indexing.
 *
 * Every streaming token is its own `chat_messages` row (p50 content length: 4
 * characters), so no raw row contains a whole word and keyword search cannot
 * match one. This module concatenates consecutive same-role tokens into
 * `chat_messages_grouped` and indexes the result in FTS5.
 *
 * A pass is INCREMENTAL. `chat_sessions.materialized_through_created_at` /
 * `..._sequence` record the last token folded into the index, so a session that
 * sleeps, wakes, writes more, and sleeps again is indexed once per pass over the
 * new tail only. Durable Object `rowsRead` is billed, so a full rebuild per
 * sleep would be quadratic in the session's lifetime message count.
 */
import { log } from '../../lib/logger';
import {
  type MaterializationState,
  parseCount,
  parseMaterializationState,
  parseMaterializationToken,
  parseRowid,
  parseSessionId,
  parseTrailingGroup,
} from './row-schemas';

/**
 * Roles whose consecutive tokens are concatenated into a single grouped message.
 * Non-groupable roles (user, system, plan) pass through as individual messages.
 */
const GROUPABLE_ROLES = new Set(['assistant', 'tool', 'thinking']);

/** DO session statuses after which no further transcript rows can arrive. */
const TERMINAL_STATUSES = new Set(['stopped', 'failed']);

/**
 * Storage relief (`grouped-fts-cleanup.ts`) deletes every grouped/FTS row for a
 * terminal session and moves it to the raw-message LIKE fallback. Re-indexing it
 * would undo the reclaimed bytes, so that state is a hard refusal here.
 */
export const SEARCH_INDEX_STATE_PRUNED = 'grouped_fts_pruned';
/** Terminal session: every non-system message is in the index. */
export const SEARCH_INDEX_STATE_COMPLETE = 'complete';
/** Live or sleeping session: indexed through the watermark, more may arrive. */
export const SEARCH_INDEX_STATE_PARTIAL = 'partial';

/** Sessions materialized per sweep call. */
export const DEFAULT_MATERIALIZATION_SWEEP_LIMIT = 50;
/**
 * Sessions the sweep is allowed to examine per call. The `EXISTS` probe below is
 * one indexed lookup per candidate, but without a cap a DO whose sessions are all
 * indexed would scan every session on every call (rule 47).
 */
export const DEFAULT_MATERIALIZATION_SWEEP_SCAN_LIMIT = 500;

/**
 * SQLite has no infinity for an integer column, and `Number.MAX_SAFE_INTEGER`
 * exceeds any real `chat_messages.sequence` (one per message per session).
 */
const SEQUENCE_ABOVE_ANY_ROW = Number.MAX_SAFE_INTEGER;

interface Watermark {
  createdAt: number;
  sequence: number;
}

interface GroupedMessage {
  id: string;
  role: string;
  content: string;
  createdAt: number;
}

/**
 * The last token already folded into the index, or `null` when nothing is.
 *
 * The watermark columns arrived in DO migration 057. Two kinds of row read back
 * NULL: sessions materialized by the pre-watermark implementation, and sessions
 * rehomed by an archive migration (`archive-sharding.ts` copies `materialized_at`
 * but not the watermark). Both were materialized by a pass that read EVERY token
 * then stamped `materialized_at = Date.now()`, so `materialized_at` is greater
 * than or equal to the `created_at` of every token that pass covered — which makes
 * `(materialized_at, +above-any-sequence)` an exact watermark for them. It skips
 * nothing that was missed and re-reads nothing that was indexed.
 */
function resolveWatermark(state: MaterializationState): Watermark | null {
  if (state.throughCreatedAt !== null) {
    return { createdAt: state.throughCreatedAt, sequence: state.throughSequence ?? 0 };
  }
  if (state.materializedAt !== null) {
    return { createdAt: state.materializedAt, sequence: SEQUENCE_ABOVE_ANY_ROW };
  }
  return null;
}

function readMaterializationState(sql: SqlStorage, sessionId: string): MaterializationState | null {
  const row = sql
    .exec(
      `SELECT status, materialized_at, search_index_state,
              materialized_through_created_at, materialized_through_sequence
       FROM chat_sessions WHERE id = ?`,
      sessionId
    )
    .toArray()[0];
  return row ? parseMaterializationState(row) : null;
}

/**
 * Tokens written after the watermark, oldest first.
 *
 * `created_at >= ?` is the range scan that keeps reads proportional to new rows —
 * it uses `idx_chat_messages_session_seq(session_id, created_at, sequence)`. The
 * disjunction that follows only re-filters the boundary millisecond.
 */
function readTokensAfter(
  sql: SqlStorage,
  sessionId: string,
  watermark: Watermark | null
): Array<ReturnType<typeof parseMaterializationToken>> {
  const cursor = watermark
    ? sql.exec(
        `SELECT id, role, content, created_at, sequence
         FROM chat_messages
         WHERE session_id = ?
           AND COALESCE(origin, 'user') != 'system'
           AND created_at >= ?
           AND (created_at > ? OR COALESCE(sequence, 0) > ?)
         ORDER BY created_at ASC, sequence ASC`,
        sessionId,
        watermark.createdAt,
        watermark.createdAt,
        watermark.sequence
      )
    : sql.exec(
        `SELECT id, role, content, created_at, sequence
         FROM chat_messages
         WHERE session_id = ? AND COALESCE(origin, 'user') != 'system'
         ORDER BY created_at ASC, sequence ASC`,
        sessionId
      );
  return cursor.toArray().map((row) => parseMaterializationToken(row));
}

function groupTokens(
  tokens: Array<ReturnType<typeof parseMaterializationToken>>
): GroupedMessage[] {
  const grouped: GroupedMessage[] = [];
  for (const token of tokens) {
    const last = grouped[grouped.length - 1];
    if (last && last.role === token.role && GROUPABLE_ROLES.has(token.role)) {
      last.content += token.content;
    } else {
      grouped.push({
        id: token.id,
        role: token.role,
        content: token.content,
        createdAt: token.createdAt,
      });
    }
  }
  return grouped;
}

/**
 * FTS5 external-content tables are not kept in sync by SQLite — the index rows
 * are written by hand. A missing virtual table is tolerated: the grouped table
 * alone still serves LIKE search.
 */
function insertFtsRow(sql: SqlStorage, rowid: number, content: string): void {
  try {
    sql.exec(
      'INSERT OR IGNORE INTO chat_messages_grouped_fts (rowid, content) VALUES (?, ?)',
      rowid,
      content
    );
  } catch {
    // FTS5 table may not exist — grouped table still has value for LIKE search
  }
}

function replaceFtsRow(
  sql: SqlStorage,
  rowid: number,
  previousContent: string,
  content: string
): void {
  try {
    sql.exec(
      `INSERT INTO chat_messages_grouped_fts(chat_messages_grouped_fts, rowid, content)
       VALUES('delete', ?, ?)`,
      rowid,
      previousContent
    );
    sql.exec(
      'INSERT INTO chat_messages_grouped_fts (rowid, content) VALUES (?, ?)',
      rowid,
      content
    );
  } catch {
    // FTS5 table may not exist — grouped table still has value for LIKE search
  }
}

/**
 * Append a group, skipping the FTS write when the grouped row already existed.
 *
 * `RETURNING rowid` both yields the rowid and reports whether the insert happened,
 * replacing an `INSERT OR IGNORE` followed by a `SELECT rowid` — one fewer indexed
 * read per group, on a path whose whole purpose is to keep reads proportional to
 * new messages. Skipping the FTS write for an already-present group also keeps a
 * replayed pass from appending redundant postings for a rowid that already has
 * them. (Measured in workerd: redundant postings on this external-content table do
 * not produce duplicate MATCH hits, so this is index hygiene, not a search fix.)
 */
function insertGroup(sql: SqlStorage, sessionId: string, group: GroupedMessage): void {
  const inserted = sql
    .exec(
      `INSERT INTO chat_messages_grouped (id, session_id, role, content, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO NOTHING
       RETURNING rowid`,
      group.id,
      sessionId,
      group.role,
      group.content,
      group.createdAt
    )
    .toArray()[0];
  if (!inserted) return;
  insertFtsRow(sql, parseRowid(inserted, 'materialization.grouped_rowid'), group.content);
}

/**
 * The grouped row a previous pass wrote last for this session.
 *
 * `created_at` on a grouped row is the timestamp of the run's FIRST token, and
 * runs are written in token order, so the newest `created_at` (rowid breaking a
 * same-millisecond tie) is the run a new same-role token continues.
 */
function readTrailingGroup(
  sql: SqlStorage,
  sessionId: string
): ReturnType<typeof parseTrailingGroup> | null {
  const row = sql
    .exec(
      `SELECT rowid, role, content FROM chat_messages_grouped
       WHERE session_id = ?
       ORDER BY created_at DESC, rowid DESC
       LIMIT 1`,
      sessionId
    )
    .toArray()[0];
  return row ? parseTrailingGroup(row) : null;
}

/**
 * Fold the leading run of a new batch into the grouped row it continues.
 *
 * A sleep normally lands between turns, so this is rare — but "rare" is not
 * "impossible" (a session can be slept while an assistant turn is streaming), and
 * splitting one run across two grouped rows would put a word boundary back into
 * the index, which is the defect this whole module exists to remove.
 *
 * Returns true when the caller must drop the first group from its insert list.
 */
function extendTrailingGroup(sql: SqlStorage, sessionId: string, head: GroupedMessage): boolean {
  if (!GROUPABLE_ROLES.has(head.role)) return false;
  const trailing = readTrailingGroup(sql, sessionId);
  if (!trailing || trailing.role !== head.role) return false;

  const merged = trailing.content + head.content;
  sql.exec(
    'UPDATE chat_messages_grouped SET content = ? WHERE rowid = ?',
    merged,
    trailing.rowid
  );
  replaceFtsRow(sql, trailing.rowid, trailing.content, merged);
  return true;
}

function stampIndexState(
  sql: SqlStorage,
  sessionId: string,
  indexState: string,
  watermark: Watermark | null
): void {
  const now = Date.now();
  sql.exec(
    `UPDATE chat_sessions
     SET materialized_at = ?,
         materialized_through_created_at = ?,
         materialized_through_sequence = ?,
         search_index_state = ?,
         search_index_updated_at = ?,
         search_index_degradation_reason = NULL
     WHERE id = ?`,
    now,
    watermark?.createdAt ?? null,
    watermark?.sequence ?? null,
    indexState,
    now,
    sessionId
  );
}

/**
 * Materialize grouped messages for a session, from its watermark forward.
 *
 * Safe to call on every sleep and again on stop. Idempotent: a call with no new
 * messages and no state promotion to make writes nothing.
 */
export function materializeSession(sql: SqlStorage, sessionId: string): void {
  const state = readMaterializationState(sql, sessionId);
  if (!state) return;
  if (state.searchIndexState === SEARCH_INDEX_STATE_PRUNED) return;

  const terminal = TERMINAL_STATUSES.has(state.status);
  const watermark = resolveWatermark(state);
  const tokens = readTokensAfter(sql, sessionId, watermark);

  if (tokens.length === 0) {
    // Nothing new. Only write if terminalization has something left to record:
    // an empty or fully-indexed session that has since stopped is now complete.
    if (terminal && state.searchIndexState !== SEARCH_INDEX_STATE_COMPLETE) {
      stampIndexState(sql, sessionId, SEARCH_INDEX_STATE_COMPLETE, watermark);
    }
    return;
  }

  const groups = groupTokens(tokens);
  const head = groups[0];
  const extended = watermark !== null && head !== undefined && extendTrailingGroup(sql, sessionId, head);
  for (const group of extended ? groups.slice(1) : groups) {
    insertGroup(sql, sessionId, group);
  }

  const last = tokens[tokens.length - 1]!;
  stampIndexState(
    sql,
    sessionId,
    terminal ? SEARCH_INDEX_STATE_COMPLETE : SEARCH_INDEX_STATE_PARTIAL,
    { createdAt: last.createdAt, sequence: last.sequence }
  );
}

/**
 * Selects sessions with non-system messages past their watermark.
 *
 * Ranked newest-updated first: the point of the index is that recent work is
 * searchable, so a truncated scan must drop the oldest sessions, not arbitrary
 * ones (rule 65). `remaining` discloses what the cap left behind.
 */
const PENDING_SESSIONS_CTE = `
  WITH candidates AS (
    SELECT s.id AS id,
           COALESCE(s.materialized_through_created_at, s.materialized_at) AS wm_created_at,
           CASE WHEN s.materialized_through_created_at IS NOT NULL
                THEN COALESCE(s.materialized_through_sequence, 0)
                ELSE ${SEQUENCE_ABOVE_ANY_ROW} END AS wm_sequence
    FROM chat_sessions s
    WHERE COALESCE(s.search_index_state, '') != '${SEARCH_INDEX_STATE_PRUNED}'
    ORDER BY s.updated_at DESC, s.id DESC
    LIMIT ?
  )`;

const PENDING_SESSIONS_PREDICATE = `
  EXISTS (
    SELECT 1 FROM chat_messages m
    WHERE m.session_id = c.id
      AND COALESCE(m.origin, 'user') != 'system'
      AND (c.wm_created_at IS NULL
           OR m.created_at > c.wm_created_at
           OR (m.created_at = c.wm_created_at AND COALESCE(m.sequence, 0) > c.wm_sequence))
  )`;

function countPendingSessions(sql: SqlStorage, scanLimit: number): number {
  const row = sql
    .exec(
      `${PENDING_SESSIONS_CTE}
       SELECT COUNT(*) AS count FROM candidates c WHERE ${PENDING_SESSIONS_PREDICATE}`,
      scanLimit
    )
    .toArray()[0];
  return row ? parseCount(row, 'materialization.remaining') : 0;
}

/**
 * Materialize sessions whose transcript has outrun their search index.
 *
 * Replaces the old `status = 'stopped' AND materialized_at IS NULL` sweep: once a
 * sleeping session can be indexed mid-life, "never indexed" is no longer the same
 * question as "has unindexed messages".
 */
export function materializePendingSessions(
  sql: SqlStorage,
  limit: number = DEFAULT_MATERIALIZATION_SWEEP_LIMIT,
  scanLimit: number = DEFAULT_MATERIALIZATION_SWEEP_SCAN_LIMIT
): { materialized: number; errors: number; remaining: number } {
  const sessions = sql
    .exec(
      `${PENDING_SESSIONS_CTE}
       SELECT c.id AS id FROM candidates c WHERE ${PENDING_SESSIONS_PREDICATE} LIMIT ?`,
      scanLimit,
      limit
    )
    .toArray();

  let materialized = 0;
  let errors = 0;
  for (const row of sessions) {
    try {
      materializeSession(sql, parseSessionId(row, 'materialization.batch_session'));
      materialized++;
    } catch (e) {
      log.error('materialization.session_failed', {
        sessionId: row.id,
        error: String(e),
      });
      errors++;
    }
  }

  return { materialized, errors, remaining: countPendingSessions(sql, scanLimit) };
}
