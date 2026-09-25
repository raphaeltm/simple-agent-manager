/**
 * Message search for one ProjectData object, with a worst-case cost set by configuration rather
 * than by how much history the object holds.
 *
 * Why it is bounded: on 2026-09-18..24 every `Durable Object is overloaded` and `exceeded its CPU
 * time limit and was reset` error on the SAM project's root object followed one project-wide
 * search. Workers Observability recorded ten `searchMessages` invocations at 25-32.5 s of CPU —
 * seven killed at the limit after ~65 s of wall time, during which every chat, activity and
 * heartbeat request queued behind them. The keyword fallback was a full scan of `chat_messages`
 * (`SCAN m`: 7.4 M rows, 3.2 GB of content) and the full-text half computed bm25 for every match.
 * See `tasks/archive/2026-09-25-projectdata-root-overload.md`.
 *
 * Both halves now examine a bounded window:
 * - Full-text: bm25 ranks only the newest `ftsCandidateLimit` matching grouped rows, scored in the
 *   one scan that finds them. When fewer match, every match is ranked, exactly as before. A
 *   session-scoped search counts only that session's matches, examining at most `ftsScanLimit`
 *   index entries inside the session's rowid span. (bm25's IDF count and the step over newer
 *   matches outside a session's span stay linear in the term's matches; see `searchMessagesFts`.)
 * - Keyword fallback: scans only the newest `keywordScanRowLimit` raw rows — project-wide by rowid
 *   (insertion order), session-scoped by that session's own newest rows.
 *
 * A consumer cannot notice what it was never shown, so every search reports `coverage`, and callers
 * surface it (`.claude/rules/65`).
 */
import { D1_MAX_BOUND_PARAMETERS } from '../../lib/d1-limits';
import { log } from '../../lib/logger';
import { parsePositiveInt } from '../../lib/route-helpers';
import {
  appendRoleCondition,
  buildFtsQuery,
  mapSearchRows,
  type SearchResult,
} from './message-search-rows';

export type { SearchResult } from './message-search-rows';
export { buildFtsQuery, extractSnippet } from './message-search-rows';

/** Newest full-text matches ranked by bm25. Older matches are not ranked. */
export const DEFAULT_PROJECT_DATA_SEARCH_FTS_CANDIDATE_LIMIT = 2_000;
/**
 * Full-text index entries inside a session's rowid span that a session-scoped search examines
 * (newest first) while collecting that session's newest `ftsCandidateLimit` matches.
 */
export const DEFAULT_PROJECT_DATA_SEARCH_FTS_SCAN_LIMIT = 20_000;
/** Newest raw messages the keyword fallback examines. Older rows are not scanned. */
export const DEFAULT_PROJECT_DATA_SEARCH_KEYWORD_SCAN_ROW_LIMIT = 50_000;

export interface MessageSearchBounds {
  ftsCandidateLimit: number;
  ftsScanLimit: number;
  keywordScanRowLimit: number;
}

export interface MessageSearchBoundsEnv {
  PROJECT_DATA_SEARCH_FTS_CANDIDATE_LIMIT?: string;
  PROJECT_DATA_SEARCH_FTS_SCAN_LIMIT?: string;
  PROJECT_DATA_SEARCH_KEYWORD_SCAN_ROW_LIMIT?: string;
}

export function resolveMessageSearchBounds(env: MessageSearchBoundsEnv): MessageSearchBounds {
  const ftsCandidateLimit = parsePositiveInt(
    env.PROJECT_DATA_SEARCH_FTS_CANDIDATE_LIMIT,
    DEFAULT_PROJECT_DATA_SEARCH_FTS_CANDIDATE_LIMIT
  );
  return {
    ftsCandidateLimit,
    // A scan shorter than the window could never fill it; the window is the smaller promise.
    ftsScanLimit: Math.max(
      ftsCandidateLimit,
      parsePositiveInt(
        env.PROJECT_DATA_SEARCH_FTS_SCAN_LIMIT,
        DEFAULT_PROJECT_DATA_SEARCH_FTS_SCAN_LIMIT
      )
    ),
    keywordScanRowLimit: parsePositiveInt(
      env.PROJECT_DATA_SEARCH_KEYWORD_SCAN_ROW_LIMIT,
      DEFAULT_PROJECT_DATA_SEARCH_KEYWORD_SCAN_ROW_LIMIT
    ),
  };
}

/**
 * What a search did NOT look at. `*Truncated` is true only when rows outside the window exist, so
 * an empty result with both flags false really does mean "no match in this object".
 */
export interface MessageSearchCoverage {
  ftsCandidateLimit: number;
  /** More full-text matches exist than were ranked; only the newest `ftsCandidateLimit` were. */
  ftsCandidatesTruncated: boolean;
  keywordScanRowLimit: number;
  /** The keyword fallback ran. It only runs when full-text returned fewer than `limit` results. */
  keywordFallbackRan: boolean;
  /** The keyword fallback ran and older raw messages exist beyond the rows it scanned. */
  keywordScanTruncated: boolean;
}

export interface MessageSearchWithCoverage {
  results: SearchResult[];
  coverage: MessageSearchCoverage;
}

export function searchMessagesWithCoverage(
  sql: SqlStorage,
  query: string,
  sessionId: string | null,
  roles: string[] | null,
  limit: number,
  bounds: MessageSearchBounds
): MessageSearchWithCoverage {
  const fts = searchMessagesFts(sql, query, sessionId, roles, limit, bounds);
  const results = [...fts.results];
  let keywordFallbackRan = false;
  let keywordScanTruncated = false;

  if (results.length < limit) {
    keywordFallbackRan = true;
    const keyword = searchMessagesLike(
      sql,
      query,
      sessionId,
      roles,
      limit - results.length,
      bounds.keywordScanRowLimit
    );
    keywordScanTruncated = keyword.truncated;
    results.push(...keyword.results);
  }

  results.sort((a, b) => b.createdAt - a.createdAt);
  return {
    results: results.slice(0, limit),
    coverage: {
      ftsCandidateLimit: bounds.ftsCandidateLimit,
      ftsCandidatesTruncated: fts.truncated,
      keywordScanRowLimit: bounds.keywordScanRowLimit,
      keywordFallbackRan,
      keywordScanTruncated,
    },
  };
}

interface BoundedSearchResults {
  results: SearchResult[];
  truncated: boolean;
}

/** Inclusive rowid span a full-text candidate window must stay inside. */
interface RowidSpan {
  lo: number;
  hi: number;
}

/** A full-text match inside the candidate window, scored while the index was walked. */
interface FtsCandidate {
  rid: number;
  score: number;
  role: unknown;
}

interface FtsCandidateWindow {
  candidates: FtsCandidate[];
  truncated: boolean;
}

/**
 * Full-text ranking over a window of the newest matches.
 *
 * bm25 is computed inside a newest-first scan that `LIMIT` stops, so rows past the window are never
 * visited by this statement; ranking and the row reads that follow touch only the window. What no
 * window can bound: bm25 counts every match of each phrase once per query for its IDF, and a
 * session-scoped scan must step over the newer matches of other sessions to reach its span. Both
 * are linear in the term's matches at tens of nanoseconds each (~30-60 ms for 500 K matches,
 * measured) — the per-match scoring, joins and content reads this replaced cost 25-32 s.
 */
function searchMessagesFts(
  sql: SqlStorage,
  query: string,
  sessionId: string | null,
  roles: string[] | null,
  limit: number,
  bounds: MessageSearchBounds
): BoundedSearchResults {
  const ftsQuery = buildFtsQuery(query);
  if (!ftsQuery) return { results: [], truncated: false };

  try {
    let window: FtsCandidateWindow;
    if (sessionId) {
      // A session's grouped rows are written by its own materialization passes, so every one of
      // them sits inside this span. Newer matches past its end can never belong to it.
      const span = readGroupedRowidSpan(sql, sessionId);
      if (!span) return { results: [], truncated: false };
      window = readSessionFtsCandidateWindow(sql, ftsQuery, sessionId, span, bounds);
    } else {
      window = readProjectFtsCandidateWindow(sql, ftsQuery, bounds.ftsCandidateLimit);
    }

    // Ties break on ascending rowid — exactly what `ORDER BY rank` returned, and what the archive
    // shard's `searchArchiveProjection` still returns — so a session reads the same results before
    // and after it is archived.
    const ranked = window.candidates
      .filter((candidate) => !roles?.length || roles.includes(String(candidate.role)))
      .sort((a, b) => a.score - b.score || a.rid - b.rid)
      .slice(0, limit);
    return {
      results: mapSearchRows(readGroupedRowsInOrder(sql, ranked), query, 'fts'),
      truncated: window.truncated,
    };
  } catch (e) {
    log.error('messages.fts5_search_failed', { error: String(e) });
    return { results: [], truncated: false };
  }
}

function readGroupedRowidSpan(sql: SqlStorage, sessionId: string): RowidSpan | null {
  const row = sql
    .exec(
      'SELECT MIN(rowid) AS lo, MAX(rowid) AS hi FROM chat_messages_grouped WHERE session_id = ?',
      sessionId
    )
    .toArray()[0];
  return typeof row?.lo === 'number' && typeof row.hi === 'number'
    ? { lo: row.lo, hi: row.hi }
    : null;
}

/** The newest `candidateLimit` matches; one extra row only says that older matches exist. */
function readProjectFtsCandidateWindow(
  sql: SqlStorage,
  ftsQuery: string,
  candidateLimit: number
): FtsCandidateWindow {
  const rows = sql
    .exec(
      `SELECT w.rid AS rid, w.score AS score, m.role AS role
       FROM (
         SELECT rowid AS rid, bm25(chat_messages_grouped_fts) AS score
         FROM chat_messages_grouped_fts
         WHERE chat_messages_grouped_fts MATCH ?
         ORDER BY rowid DESC
         LIMIT ?
       ) w
       JOIN chat_messages_grouped m ON m.rowid = w.rid
       ORDER BY w.rid DESC`,
      ftsQuery,
      candidateLimit + 1
    )
    .toArray();
  return {
    candidates: toFtsCandidates(rows.slice(0, candidateLimit)),
    truncated: rows.length > candidateLimit,
  };
}

/**
 * A session's matches are interleaved with other sessions' rows inside its span, so counting raw
 * index entries would spend the window on other sessions. This examines at most `ftsScanLimit`
 * entries of the span, newest first, and keeps only this session's, so the window is the
 * session's newest `ftsCandidateLimit` matches unless the scan cap is reached first.
 */
function readSessionFtsCandidateWindow(
  sql: SqlStorage,
  ftsQuery: string,
  sessionId: string,
  span: RowidSpan,
  bounds: MessageSearchBounds
): FtsCandidateWindow {
  const rows = sql
    .exec(
      `SELECT scanned.rid AS rid, scanned.score AS score, m.role AS role,
              m.session_id = ? AS in_session
       FROM (
         SELECT rowid AS rid, bm25(chat_messages_grouped_fts) AS score
         FROM chat_messages_grouped_fts
         WHERE chat_messages_grouped_fts MATCH ? AND rowid BETWEEN ? AND ?
         ORDER BY rowid DESC
         LIMIT ?
       ) scanned
       JOIN chat_messages_grouped m ON m.rowid = scanned.rid
       ORDER BY scanned.rid DESC`,
      sessionId,
      ftsQuery,
      span.lo,
      span.hi,
      bounds.ftsScanLimit + 1
    )
    .toArray();
  const scanCapped = rows.length > bounds.ftsScanLimit;
  const scanned = scanCapped ? rows.slice(0, bounds.ftsScanLimit) : rows;
  const inSession = scanned.filter((row) => row.in_session === 1);
  // More of this session's matches may sit in the unscanned remainder, so a capped scan reports
  // truncation even when the window did not fill.
  return {
    candidates: toFtsCandidates(inSession.slice(0, bounds.ftsCandidateLimit)),
    truncated: scanCapped || inSession.length > bounds.ftsCandidateLimit,
  };
}

function toFtsCandidates(rows: Record<string, unknown>[]): FtsCandidate[] {
  const candidates: FtsCandidate[] = [];
  for (const row of rows) {
    if (typeof row.rid !== 'number' || typeof row.score !== 'number') continue;
    candidates.push({ rid: row.rid, score: row.score, role: row.role });
  }
  return candidates;
}

/** Result rows for the ranked candidates, in rank order, within the bound-parameter ceiling. */
function readGroupedRowsInOrder(
  sql: SqlStorage,
  ranked: readonly FtsCandidate[]
): Record<string, unknown>[] {
  const byRid = new Map<number, Record<string, unknown>>();
  for (let start = 0; start < ranked.length; start += D1_MAX_BOUND_PARAMETERS) {
    const rids = ranked.slice(start, start + D1_MAX_BOUND_PARAMETERS).map((c) => c.rid);
    const placeholders = rids.map(() => '?').join(', ');
    const rows = sql
      .exec(
        `SELECT m.rowid AS rid, m.id, m.session_id, m.role, m.content, m.created_at,
                s.topic AS session_topic, s.task_id AS session_task_id
         FROM chat_messages_grouped m
         JOIN chat_sessions s ON s.id = m.session_id
         WHERE m.rowid IN (${placeholders})`,
        ...rids
      )
      .toArray();
    for (const row of rows) {
      if (typeof row.rid === 'number') byRid.set(row.rid, row);
    }
  }
  const ordered: Record<string, unknown>[] = [];
  for (const candidate of ranked) {
    const row = byRid.get(candidate.rid);
    if (row) ordered.push(row);
  }
  return ordered;
}

/**
 * Keyword fallback for text the full-text index does not cover: the unindexed tail of live or
 * woken sessions, and sessions whose grouped rows storage relief pruned.
 */
function searchMessagesLike(
  sql: SqlStorage,
  query: string,
  sessionId: string | null,
  roles: string[] | null,
  limit: number,
  scanRowLimit: number
): BoundedSearchResults {
  const escapedQuery = query.replace(/[%_\\]/g, '\\$&');
  // The window predicate comes first so SQLite drives the scan from it (a rowid range, or the
  // session's `(session_id, created_at)` index) and never evaluates LIKE outside the window.
  const conditions: string[] = [];
  const params: (string | number)[] = [];
  let truncated: boolean;

  if (sessionId) {
    const window = readSessionKeywordWindow(sql, sessionId, scanRowLimit);
    conditions.push('m.session_id = ?');
    params.push(sessionId);
    if (window.floorCreatedAt !== null) {
      conditions.push('m.created_at >= ?');
      params.push(window.floorCreatedAt);
    }
    truncated = window.truncated;
  } else {
    const window = readProjectKeywordWindow(sql, scanRowLimit);
    if (window.floorRowid !== null) {
      conditions.push('m.rowid > ?');
      params.push(window.floorRowid);
    }
    truncated = window.truncated;
  }

  conditions.push("m.content LIKE ? ESCAPE '\\'", "COALESCE(m.origin, 'user') != 'system'");
  params.push(`%${escapedQuery}%`);
  appendRoleCondition(conditions, params, roles);

  // Materialization is incremental, so "this session has been indexed" is no
  // longer the same question as "this message has been indexed". Excluding the
  // whole session would drop everything a woken session wrote since its last
  // sleep — text that is findable today. Mirrors `resolveWatermark()` in
  // `materialization.ts`: no watermark columns means the legacy pass covered
  // everything up to `materialized_at`.
  //
  // The trailing `sequence` arm covers rows the indexer's own seek cannot reach.
  // `created_at` is the VM agent's clock and `sequence` is assigned here at
  // insert, so a batch that retried across a sleep can land with a created_at
  // BELOW the watermark and a sequence above it. The indexed scan seeks on
  // created_at and skips those; this fallback does not seek, so it can and must
  // still return them. Streaming assistant tokens are too short for a LIKE hit,
  // so this rescues whole-row content (user turns) rather than a split word;
  // closing the streaming case properly is idea 01M315GZ5P6QGSHM6CB730PMR9.
  conditions.push(
    `(s.materialized_at IS NULL
      OR m.created_at > COALESCE(s.materialized_through_created_at, s.materialized_at)
      OR (s.materialized_through_created_at IS NOT NULL
          AND m.created_at = s.materialized_through_created_at
          AND COALESCE(m.sequence, 0) > COALESCE(s.materialized_through_sequence, 0))
      OR (s.materialized_through_sequence IS NOT NULL
          AND COALESCE(m.sequence, 0) > s.materialized_through_sequence))`
  );
  params.push(limit);

  const whereClause = conditions.join(' AND ');
  const rows = sql
    .exec(
      `SELECT m.id, m.session_id, m.role, m.content, m.created_at,
              s.topic AS session_topic, s.task_id AS session_task_id
       FROM chat_messages m
       JOIN chat_sessions s ON s.id = m.session_id
       WHERE ${whereClause}
       ORDER BY m.created_at DESC
       LIMIT ?`,
      ...params
    )
    .toArray();
  return { results: mapSearchRows(rows, query, 'keyword'), truncated };
}

/**
 * `rowid` is insertion order, so the newest `scanRowLimit` rowids are the newest raw messages.
 * Archive deletes remove old rows only, so the recent range stays dense.
 */
function readProjectKeywordWindow(
  sql: SqlStorage,
  scanRowLimit: number
): { floorRowid: number | null; truncated: boolean } {
  // Two scalar subqueries, not `SELECT MIN(rowid), MAX(rowid)`: SQLite's min/max optimization
  // reads one b-tree edge only when a query has a single min() or max(); both in one SELECT is a
  // full table scan — the very cost this window exists to avoid.
  const row = sql
    .exec(
      `SELECT (SELECT MIN(rowid) FROM chat_messages) AS lo,
              (SELECT MAX(rowid) FROM chat_messages) AS hi`
    )
    .toArray()[0];
  if (typeof row?.lo !== 'number' || typeof row.hi !== 'number') {
    return { floorRowid: null, truncated: false };
  }
  const floorRowid = row.hi - scanRowLimit;
  return floorRowid >= row.lo
    ? { floorRowid, truncated: true }
    : { floorRowid: null, truncated: false };
}

function readSessionKeywordWindow(
  sql: SqlStorage,
  sessionId: string,
  scanRowLimit: number
): { floorCreatedAt: number | null; truncated: boolean } {
  const floorRow = sql
    .exec(
      `SELECT created_at FROM chat_messages
       WHERE session_id = ?
       ORDER BY created_at DESC
       LIMIT 1 OFFSET ?`,
      sessionId,
      scanRowLimit - 1
    )
    .toArray()[0];
  const floorCreatedAt = floorRow?.created_at;
  if (typeof floorCreatedAt !== 'number') return { floorCreatedAt: null, truncated: false };
  const older = sql
    .exec(
      'SELECT 1 AS present FROM chat_messages WHERE session_id = ? AND created_at < ? LIMIT 1',
      sessionId,
      floorCreatedAt
    )
    .toArray()[0];
  return { floorCreatedAt, truncated: older !== undefined };
}
