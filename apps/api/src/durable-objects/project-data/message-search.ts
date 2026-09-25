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
 * See `tasks/active/2026-09-25-projectdata-root-overload.md`.
 *
 * Both halves now examine a bounded window:
 * - Full-text: bm25 ranks only the newest `ftsCandidateLimit` matching grouped rows. When fewer
 *   match, every match is ranked, exactly as before. A session-scoped search counts only that
 *   session's matches, walking at most `ftsScanLimit` newer index entries to find them.
 * - Keyword fallback: scans only the newest `keywordScanRowLimit` raw rows — project-wide by rowid
 *   (insertion order), session-scoped by that session's own newest rows.
 *
 * A consumer cannot notice what it was never shown, so every search reports `coverage`, and callers
 * surface it (`.claude/rules/65`).
 */
import { buildSafeFtsQuery } from '../../lib/fts5';
import { log } from '../../lib/logger';
import { parsePositiveInt } from '../../lib/route-helpers';
import { parseSearchResultRow, type SearchResultParsed } from './row-schemas';

/** Newest full-text matches ranked by bm25. Older matches are not ranked. */
export const DEFAULT_PROJECT_DATA_SEARCH_FTS_CANDIDATE_LIMIT = 2_000;
/**
 * Full-text index entries a session-scoped search may walk (newest first, inside the session's
 * rowid span) while collecting that session's newest `ftsCandidateLimit` matches.
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

export type SearchResult = {
  id: string;
  sessionId: string;
  role: string;
  snippet: string;
  createdAt: number;
  sessionTopic: string | null;
  sessionTaskId: string | null;
};

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
    let span: RowidSpan | null = null;
    let window: FtsCandidateWindow;
    if (sessionId) {
      // A session's grouped rows are written by its own materialization passes, so every one of
      // them sits inside this span. Newer matches past its end can never belong to it.
      span = readGroupedRowidSpan(sql, sessionId);
      if (!span) return { results: [], truncated: false };
      window = readSessionFtsCandidateWindow(sql, ftsQuery, sessionId, span, bounds);
    } else {
      window = readProjectFtsCandidateWindow(sql, ftsQuery, bounds.ftsCandidateLimit);
    }

    const conditions: string[] = ['f.chat_messages_grouped_fts MATCH ?'];
    const params: (string | number)[] = [ftsQuery];
    if (span) {
      // Both ends, always: without the lower one a session whose window is not full would let
      // FTS5 walk every older match in the project.
      conditions.push('f.rowid BETWEEN ? AND ?', 'm.session_id = ?');
      params.push(window.floorRowid ?? span.lo, span.hi, sessionId as string);
    } else if (window.floorRowid !== null) {
      conditions.push('f.rowid >= ?');
      params.push(window.floorRowid);
    }
    appendRoleCondition(conditions, params, roles);
    params.push(limit);

    // bm25() is the default FTS5 `rank`. Naming it lets the window above stay a rowid range the
    // virtual table consumes (plan `INDEX 0:M1>`) instead of `ORDER BY rank` asking FTS5 to score
    // every match first. Ties break on recency, then id, so repeated calls agree.
    const rows = sql
      .exec(
        `SELECT m.id, m.session_id, m.role, m.content, m.created_at,
                s.topic AS session_topic, s.task_id AS session_task_id,
                bm25(chat_messages_grouped_fts) AS score
         FROM chat_messages_grouped_fts f
         JOIN chat_messages_grouped m ON m.rowid = f.rowid
         JOIN chat_sessions s ON s.id = m.session_id
         WHERE ${conditions.join(' AND ')}
         ORDER BY score, m.created_at DESC, m.id
         LIMIT ?`,
        ...params
      )
      .toArray();
    return { results: mapSearchRows(rows, query, 'fts'), truncated: window.truncated };
  } catch (e) {
    log.error('messages.fts5_search_failed', { error: String(e) });
    return { results: [], truncated: false };
  }
}

/**
 * `floorRowid` is the oldest rowid the ranked query may consider; `null` leaves it unconstrained,
 * which is exactly the pre-window behavior and happens whenever fewer matches exist than the window.
 */
interface FtsCandidateWindow {
  floorRowid: number | null;
  truncated: boolean;
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

/** Walks the doclist newest first — no scoring, no joins — to the window's oldest entry. */
function readProjectFtsCandidateWindow(
  sql: SqlStorage,
  ftsQuery: string,
  candidateLimit: number
): FtsCandidateWindow {
  // The row at OFFSET limit-1 is the oldest one inside the window; a second row means more
  // matches exist than the window ranks.
  const rows = sql
    .exec(
      `SELECT rowid AS rid FROM chat_messages_grouped_fts
       WHERE chat_messages_grouped_fts MATCH ?
       ORDER BY rowid DESC
       LIMIT 2 OFFSET ?`,
      ftsQuery,
      candidateLimit - 1
    )
    .toArray();
  const floor = rows[0]?.rid;
  if (typeof floor !== 'number' || rows.length < 2) return { floorRowid: null, truncated: false };
  return { floorRowid: floor, truncated: true };
}

/**
 * A session's matches are interleaved with other sessions' rows inside its span, so counting raw
 * doclist entries would spend the window on other sessions. This walks at most `ftsScanLimit`
 * entries newest first and keeps only this session's, so the window is the session's newest
 * `ftsCandidateLimit` matches unless the scan cap is reached first.
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
      `SELECT scanned.rid AS rid, m.session_id = ? AS in_session
       FROM (
         SELECT rowid AS rid FROM chat_messages_grouped_fts
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
  let sessionMatches = 0;
  for (let i = 0; i < scanned.length; i++) {
    const row = scanned[i];
    if (row?.in_session !== 1 || typeof row.rid !== 'number') continue;
    sessionMatches++;
    if (sessionMatches < bounds.ftsCandidateLimit) continue;
    // A full window. More of this session's matches may sit in the unscanned remainder, so a
    // capped scan must report truncation even if none appear in what was scanned.
    const moreInScan = scanned.slice(i + 1).some((older) => older?.in_session === 1);
    return { floorRowid: row.rid, truncated: moreInScan || scanCapped };
  }
  const oldestScanned = scanned[scanned.length - 1]?.rid;
  return scanCapped && typeof oldestScanned === 'number'
    ? { floorRowid: oldestScanned, truncated: true }
    : { floorRowid: null, truncated: false };
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

  const rows = sql
    .exec(
      `SELECT m.id, m.session_id, m.role, m.content, m.created_at,
              s.topic AS session_topic, s.task_id AS session_task_id
       FROM chat_messages m
       JOIN chat_sessions s ON s.id = m.session_id
       WHERE ${conditions.join(' AND ')}
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

function appendRoleCondition(
  conditions: string[],
  params: (string | number)[],
  roles: string[] | null
): void {
  if (!roles || roles.length === 0) return;
  conditions.push(`m.role IN (${roles.map(() => '?').join(', ')})`);
  params.push(...roles);
}

/** One malformed row degrades to a missing result, never a failed search (`.claude/rules/50`). */
function mapSearchRows(
  rows: Record<string, unknown>[],
  query: string,
  source: 'fts' | 'keyword'
): SearchResult[] {
  const results: SearchResult[] = [];
  for (const row of rows) {
    try {
      results.push(toSearchResult(parseSearchResultRow(row), query));
    } catch (error) {
      log.warn('messages.search_row_skipped', {
        source,
        messageId: typeof row.id === 'string' ? row.id : null,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return results;
}

function toSearchResult(parsed: SearchResultParsed, query: string): SearchResult {
  return {
    id: parsed.id,
    sessionId: parsed.sessionId,
    role: parsed.role,
    snippet: extractSnippet(parsed.content, query),
    createdAt: parsed.createdAt,
    sessionTopic: parsed.sessionTopic,
    sessionTaskId: parsed.sessionTaskId,
  };
}

export function buildFtsQuery(query: string): string | null {
  return buildSafeFtsQuery(query);
}

export function extractSnippet(content: string, query: string): string {
  const lowerContent = content.toLowerCase();
  const matchIdx = lowerContent.indexOf(query.toLowerCase());
  if (matchIdx === -1) {
    return content.slice(0, 200) + (content.length > 200 ? '...' : '');
  }
  const start = Math.max(0, matchIdx - 80);
  const end = Math.min(content.length, matchIdx + query.length + 120);
  return (start > 0 ? '...' : '') + content.slice(start, end) + (end < content.length ? '...' : '');
}
