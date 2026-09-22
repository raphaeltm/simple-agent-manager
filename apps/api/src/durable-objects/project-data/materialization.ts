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
import { parsePositiveInt } from '../../lib/route-helpers';
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
/** Derived rows are being removed before a full rebuild after a backdated write. */
export const SEARCH_INDEX_STATE_REBUILD_REQUIRED = 'rebuild_required';
const SEARCH_INDEX_STATE_BACKUP_CLEANUP = 'backup_cleanup';
const PROJECT_SEARCH_PROJECTION_VERSION = 1;

/** Sessions materialized per sweep call. */
export const DEFAULT_MATERIALIZATION_SWEEP_LIMIT = 50;
/**
 * Candidates the sweep ranks per call. This caps the `EXISTS` probes and the
 * materialization work, NOT the `chat_sessions` rows read.
 *
 * Each probe is cheap only because `PENDING_SESSIONS_PREDICATE` uses the same
 * row-value seek as `readTokensAfter`: expressed as a correlated `OR` instead, it
 * degrades to a row-by-row filter from the session's FIRST message — measured at
 * 5,000 rows visited per already-indexed 5,000-message candidate.
 *
 * Measured with `EXPLAIN QUERY PLAN` and row-touch counting: the CTE's
 * `ORDER BY updated_at DESC, id DESC LIMIT ?` pushes the limit down only while
 * most rows pass the filter. Once pruned sessions outnumber the eligible tail and
 * that tail is smaller than this limit, SQLite walks the whole table looking for
 * `scanLimit` qualifying rows it will never find — 1,000,000 rows touched for 50
 * eligible sessions in the benchmark. Nothing calls this sweep today; wiring a
 * periodic caller needs a partial index on the non-pruned rows first, which is a
 * prerequisite recorded on idea `01M313TT05Q5R09D9E0ZZGW0E3`.
 */
export const DEFAULT_MATERIALIZATION_SWEEP_SCAN_LIMIT = 500;

/**
 * Tokens materialized into memory by one `SELECT`.
 *
 * A Durable Object isolate is reset when it exceeds its memory limit, and that has
 * already happened on this object: on 2026-09-05 `tableAggregateSha256` reset the
 * SAM root ProjectData twice with an unbounded `SELECT ... WHERE session_id = ?`
 * plus `toArray()` on a 100,000-message session. This read has the same shape over
 * the same table, so it pages (`apps/api/.claude/rules/69`, "Memory Is A Ceiling
 * Too"). No harness enforces the isolate limit, so the guard is proven by a
 * page-shape assertion rather than by reproducing the reset.
 */
export const DEFAULT_MATERIALIZATION_PAGE_ROWS = 500;
/**
 * Tokens one pass may materialize before stopping and leaving the rest to the next
 * pass. Paging bounds memory; this bounds the wall time and `rowsRead` a single
 * `sleepSession()` RPC can spend on a session whose whole history is unindexed —
 * every session alive when this shipped is in exactly that state.
 */
export const DEFAULT_MATERIALIZATION_MAX_ROWS_PER_PASS = 5000;
/**
 * Characters past which a grouped row stops absorbing continuations.
 *
 * Extending a run rewrites the row's WHOLE accumulated content plus both FTS
 * postings, so cost per extension is O(current size). A turn that is slept and
 * woken repeatedly while still streaming would pay O(k^2) across k extensions with
 * nothing to stop it — sleep is gated on the session being idle, but a stale
 * activity mirror has kept a session in `prompting` for four hours in production
 * before (`apps/api/.claude/rules/57`). Past this size a continuation starts a new
 * grouped row instead: one word boundary in the index, rather than unbounded
 * rewrite cost.
 */
export const DEFAULT_MATERIALIZATION_MAX_GROUP_CHARS = 65536;

/** Shared so it is not rebuilt per call and not an object literal in a signature. */
const DEFAULT_PASS_CONFIG: MaterializationPassConfig = {
  pageRows: DEFAULT_MATERIALIZATION_PAGE_ROWS,
  maxRowsPerPass: DEFAULT_MATERIALIZATION_MAX_ROWS_PER_PASS,
  maxGroupChars: DEFAULT_MATERIALIZATION_MAX_GROUP_CHARS,
};

export interface MaterializationSweepConfig {
  limit: number;
  scanLimit: number;
}

export interface MaterializationPassConfig {
  pageRows: number;
  maxRowsPerPass: number;
  maxGroupChars: number;
}

export function resolveMaterializationPassConfig(env: {
  PROJECT_DATA_MATERIALIZATION_PAGE_ROWS?: string;
  PROJECT_DATA_MATERIALIZATION_MAX_ROWS_PER_PASS?: string;
  PROJECT_DATA_MATERIALIZATION_MAX_GROUP_CHARS?: string;
}): MaterializationPassConfig {
  return {
    pageRows: parsePositiveInt(
      env.PROJECT_DATA_MATERIALIZATION_PAGE_ROWS,
      DEFAULT_MATERIALIZATION_PAGE_ROWS
    ),
    maxRowsPerPass: parsePositiveInt(
      env.PROJECT_DATA_MATERIALIZATION_MAX_ROWS_PER_PASS,
      DEFAULT_MATERIALIZATION_MAX_ROWS_PER_PASS
    ),
    maxGroupChars: parsePositiveInt(
      env.PROJECT_DATA_MATERIALIZATION_MAX_GROUP_CHARS,
      DEFAULT_MATERIALIZATION_MAX_GROUP_CHARS
    ),
  };
}

export function resolveMaterializationSweepConfig(env: {
  PROJECT_DATA_MATERIALIZATION_SWEEP_LIMIT?: string;
  PROJECT_DATA_MATERIALIZATION_SWEEP_SCAN_LIMIT?: string;
}): MaterializationSweepConfig {
  return {
    limit: parsePositiveInt(
      env.PROJECT_DATA_MATERIALIZATION_SWEEP_LIMIT,
      DEFAULT_MATERIALIZATION_SWEEP_LIMIT
    ),
    scanLimit: parsePositiveInt(
      env.PROJECT_DATA_MATERIALIZATION_SWEEP_SCAN_LIMIT,
      DEFAULT_MATERIALIZATION_SWEEP_SCAN_LIMIT
    ),
  };
}

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
  /** The last token folded into this group, for mid-page watermark checkpoints. */
  lastCreatedAt: number;
  lastSequence: number;
}

/** The grouped row a pass would continue if the next token shares its role. */
type TrailingGroup = ReturnType<typeof parseTrailingGroup>;

type ProjectSearchIndexCandidate = {
  id: string;
  state: string | null;
  materializedAt: number | null;
  projectionVersion: number | null;
};

const PROJECT_SEARCH_INDEX_CANDIDATE_SQL = `
  SELECT s.id, s.search_index_state, s.materialized_at, s.search_projection_version
  FROM chat_sessions s INDEXED BY idx_chat_sessions_project_search_pending
  WHERE s.search_index_state IN ('${SEARCH_INDEX_STATE_PRUNED}', '${SEARCH_INDEX_STATE_REBUILD_REQUIRED}', '${SEARCH_INDEX_STATE_BACKUP_CLEANUP}')
     OR (s.search_index_state = '${SEARCH_INDEX_STATE_PARTIAL}'
         AND s.status IN ('stopped', 'failed'))
     OR ((s.search_projection_version IS NULL
          OR s.search_projection_version != ${PROJECT_SEARCH_PROJECTION_VERSION})
         AND s.message_count > 0)
  ORDER BY s.updated_at DESC, s.id DESC
  LIMIT 1`;

function readProjectSearchIndexCandidate(sql: SqlStorage): ProjectSearchIndexCandidate | null {
  const row = sql.exec(PROJECT_SEARCH_INDEX_CANDIDATE_SQL).toArray()[0];
  if (!row) return null;
  if (typeof row.id !== 'string') throw new Error('Invalid project search index candidate id');
  return {
    id: row.id,
    state: typeof row.search_index_state === 'string' ? row.search_index_state : null,
    materializedAt: typeof row.materialized_at === 'number' ? row.materialized_at : null,
    projectionVersion:
      typeof row.search_projection_version === 'number' ? row.search_projection_version : null,
  };
}

function beginSearchProjectionRebuild(sql: SqlStorage, sessionId: string): void {
  sql.exec(
    `UPDATE chat_sessions
     SET materialized_at = NULL,
         materialized_through_created_at = NULL,
         materialized_through_sequence = NULL,
         search_projection_version = 0,
         search_index_state = ?,
         search_index_updated_at = ?,
         search_index_degradation_reason = ?
     WHERE id = ?`,
    SEARCH_INDEX_STATE_REBUILD_REQUIRED,
    Date.now(),
    'Grouped search projection is rebuilding; exact search uses the retained backup.',
    sessionId
  );
}

function deleteSearchProjectionPage(
  sql: SqlStorage,
  sessionId: string,
  rowLimit: number,
  byteLimit: number
): { deleted: number; hasMore: boolean } {
  const candidates = sql
    .exec(
      `SELECT rowid, length(CAST(content AS BLOB)) AS content_bytes
       FROM chat_messages_grouped
       WHERE session_id = ?
       ORDER BY created_at ASC, rowid ASC
       LIMIT ?`,
      sessionId,
      rowLimit + 1
    )
    .toArray();
  const selected: number[] = [];
  let selectedBytes = 0;
  for (const candidate of candidates.slice(0, rowLimit)) {
    const rowid = parseRowid(candidate, 'materialization.rebuild_candidate_rowid');
    if (typeof candidate.content_bytes !== 'number') {
      throw new Error('Invalid grouped message byte size during search projection rebuild');
    }
    if (selected.length > 0 && selectedBytes + candidate.content_bytes > byteLimit) break;
    selected.push(rowid);
    selectedBytes += candidate.content_bytes;
  }
  let deleted = 0;
  for (const candidateRowid of selected) {
    const row = sql
      .exec(
        `SELECT rowid, id, role, content, created_at
         FROM chat_messages_grouped WHERE rowid = ?`,
        candidateRowid
      )
      .toArray()[0];
    if (!row) throw new Error('Grouped message disappeared during search projection rebuild');
    const rowid = parseRowid(row, 'materialization.rebuild_rowid');
    if (typeof row.content !== 'string') {
      throw new Error('Invalid grouped message content during search projection rebuild');
    }
    if (
      typeof row.id !== 'string' ||
      typeof row.role !== 'string' ||
      typeof row.created_at !== 'number'
    ) {
      throw new Error('Invalid grouped message identity during search projection rebuild');
    }
    sql.exec(
      `INSERT OR IGNORE INTO chat_messages_grouped_rebuild_backup
         (id, session_id, role, content, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      row.id,
      sessionId,
      row.role,
      row.content,
      row.created_at
    );
    sql.exec(
      `INSERT INTO chat_messages_grouped_fts(chat_messages_grouped_fts, rowid, content)
       VALUES('delete', ?, ?)`,
      rowid,
      row.content
    );
    sql.exec('DELETE FROM chat_messages_grouped WHERE rowid = ?', rowid);
    deleted++;
  }
  return { deleted, hasMore: selected.length < candidates.length };
}

function deleteSearchProjectionBackupPage(
  sql: SqlStorage,
  sessionId: string,
  limit: number
): number {
  const rows = sql
    .exec(
      `SELECT id FROM chat_messages_grouped_rebuild_backup
       WHERE session_id = ? ORDER BY created_at ASC, id ASC LIMIT ?`,
      sessionId,
      limit
    )
    .toArray();
  for (const row of rows) {
    if (typeof row.id !== 'string') throw new Error('Invalid rebuild backup message id');
    sql.exec('DELETE FROM chat_messages_grouped_rebuild_backup WHERE id = ?', row.id);
  }
  return rows.length;
}

function scheduleBackupCleanupIfComplete(sql: SqlStorage, sessionId: string): void {
  const row = sql
    .exec(
      `SELECT EXISTS(
         SELECT 1 FROM chat_messages_grouped_rebuild_backup WHERE session_id = ?
       ) AS has_backup,
       search_projection_version
       FROM chat_sessions WHERE id = ?`,
      sessionId,
      sessionId
    )
    .toArray()[0];
  if (row?.has_backup !== 1 || row.search_projection_version !== PROJECT_SEARCH_PROJECTION_VERSION)
    return;
  sql.exec(
    `UPDATE chat_sessions SET search_index_state = ?, search_index_updated_at = ? WHERE id = ?`,
    SEARCH_INDEX_STATE_BACKUP_CLEANUP,
    Date.now(),
    sessionId
  );
}

function finishBackupCleanup(sql: SqlStorage, sessionId: string): void {
  sql.exec(
    `UPDATE chat_sessions
     SET search_index_state = CASE
           WHEN status IN ('stopped', 'failed') THEN ? ELSE ? END,
         search_index_updated_at = ?,
         search_index_degradation_reason = NULL
     WHERE id = ?`,
    SEARCH_INDEX_STATE_COMPLETE,
    SEARCH_INDEX_STATE_PARTIAL,
    Date.now(),
    sessionId
  );
}

function resetSearchProjectionWatermark(sql: SqlStorage, sessionId: string): void {
  sql.exec(
    `UPDATE chat_sessions
     SET materialized_at = NULL,
         materialized_through_created_at = NULL,
         materialized_through_sequence = NULL,
         search_projection_version = NULL,
         search_index_state = NULL,
         search_index_updated_at = ?,
         search_index_degradation_reason = NULL
     WHERE id = ?`,
    Date.now(),
    sessionId
  );
}

/**
 * Advance at most one session's derived search projection by one bounded pass.
 *
 * Project-wide search calls this before FTS and retries through its signed outer
 * continuation while `complete` is false. That makes a no-hit query proportional
 * to the configured materialization/delete pass instead of every retained raw
 * message, and never reports a complete result while raw rows remain unindexed.
 */
export function prepareProjectSearchIndex(
  sql: SqlStorage,
  config: MaterializationPassConfig = DEFAULT_PASS_CONFIG
): { complete: boolean; sessionId: string | null; action: string } {
  const candidate = readProjectSearchIndexCandidate(sql);
  if (!candidate) return { complete: true, sessionId: null, action: 'ready' };

  if (candidate.state === SEARCH_INDEX_STATE_BACKUP_CLEANUP) {
    const deleted = deleteSearchProjectionBackupPage(sql, candidate.id, config.pageRows);
    if (deleted >= config.pageRows) {
      return { complete: false, sessionId: candidate.id, action: 'delete_rebuild_backup' };
    }
    finishBackupCleanup(sql, candidate.id);
    return {
      complete: readProjectSearchIndexCandidate(sql) === null,
      sessionId: candidate.id,
      action: 'finish_rebuild_backup',
    };
  }

  const needsProjectionReset =
    candidate.state === SEARCH_INDEX_STATE_REBUILD_REQUIRED ||
    (candidate.projectionVersion === null && candidate.materializedAt !== null);
  if (needsProjectionReset) {
    if (candidate.materializedAt !== null) beginSearchProjectionRebuild(sql, candidate.id);
    const moved = deleteSearchProjectionPage(
      sql,
      candidate.id,
      config.pageRows,
      config.maxGroupChars
    );
    if (moved.hasMore) {
      return { complete: false, sessionId: candidate.id, action: 'delete_rebuild_projection' };
    }
    resetSearchProjectionWatermark(sql, candidate.id);
  } else if (candidate.state === SEARCH_INDEX_STATE_PRUNED) {
    resetSearchProjectionWatermark(sql, candidate.id);
  }

  materializeSession(sql, candidate.id, config);
  scheduleBackupCleanupIfComplete(sql, candidate.id);
  return {
    complete: readProjectSearchIndexCandidate(sql) === null,
    sessionId: candidate.id,
    action: 'materialize',
  };
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
              materialized_through_created_at, materialized_through_sequence,
              search_projection_version, message_count
       FROM chat_sessions WHERE id = ?`,
      sessionId
    )
    .toArray()[0];
  return row ? parseMaterializationState(row) : null;
}

/**
 * Tokens written after the watermark, oldest first.
 *
 * `(created_at, sequence) > (?, ?)` is a SQLite row-value comparison, and it is
 * what keeps reads proportional to NEW rows: the tuple is a prefix of
 * `idx_chat_messages_session_seq(session_id, created_at, sequence)`, so the engine
 * seeks straight to the watermark's position INSIDE its millisecond. Writing this
 * as `created_at >= ? AND (created_at > ? OR sequence > ?)` instead makes the
 * sequence term a residual filter, and the scan re-walks every row tied at the
 * watermark's `created_at` on every pass — measured at 201 rows re-read for a
 * 200-token burst that shared one timestamp.
 *
 * Depends on `chat_messages.sequence` being non-NULL: a row value compares
 * left-to-right and yields NULL (excluded) on a tie into a NULL. DO migration 007
 * backfilled every existing row from `rowid`, and `insertNewMessage` /
 * `persistMessageBatch` / `persistSystemMessage` all assign one.
 */
function readTokensAfter(
  sql: SqlStorage,
  sessionId: string,
  watermark: Watermark | null,
  pageRows: number
): Array<ReturnType<typeof parseMaterializationToken>> {
  const cursor = watermark
    ? sql.exec(
        `SELECT id, role, content, created_at, sequence
         FROM chat_messages
         WHERE session_id = ?
           AND COALESCE(origin, 'user') != 'system'
           AND (created_at, sequence) > (?, ?)
         ORDER BY created_at ASC, sequence ASC
         LIMIT ?`,
        sessionId,
        watermark.createdAt,
        watermark.sequence,
        pageRows
      )
    : sql.exec(
        `SELECT id, role, content, created_at, sequence
         FROM chat_messages
         WHERE session_id = ? AND COALESCE(origin, 'user') != 'system'
         ORDER BY created_at ASC, sequence ASC
         LIMIT ?`,
        sessionId,
        pageRows
      );
  return cursor.toArray().map((row) => parseMaterializationToken(row));
}

function groupTokens(
  tokens: Array<ReturnType<typeof parseMaterializationToken>>
): GroupedMessage[] {
  const grouped: GroupedMessage[] = [];
  for (const token of tokens) {
    const last = grouped[grouped.length - 1];
    if (last?.role === token.role && GROUPABLE_ROLES.has(token.role)) {
      last.content += token.content;
      last.lastCreatedAt = Math.max(last.lastCreatedAt, token.createdAt);
      last.lastSequence = Math.max(last.lastSequence, token.sequence);
    } else {
      grouped.push({
        id: token.id,
        role: token.role,
        content: token.content,
        createdAt: token.createdAt,
        lastCreatedAt: token.createdAt,
        lastSequence: token.sequence,
      });
    }
  }
  return grouped;
}

/** FTS5 external-content tables are not kept in sync by SQLite; write every row. */
function insertFtsRow(sql: SqlStorage, rowid: number, content: string): void {
  sql.exec(
    'INSERT OR IGNORE INTO chat_messages_grouped_fts (rowid, content) VALUES (?, ?)',
    rowid,
    content
  );
}

function replaceFtsRow(
  sql: SqlStorage,
  rowid: number,
  previousContent: string,
  content: string
): void {
  sql.exec(
    `INSERT INTO chat_messages_grouped_fts(chat_messages_grouped_fts, rowid, content)
     VALUES('delete', ?, ?)`,
    rowid,
    previousContent
  );
  sql.exec('INSERT INTO chat_messages_grouped_fts (rowid, content) VALUES (?, ?)', rowid, content);
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
function insertGroup(
  sql: SqlStorage,
  sessionId: string,
  group: GroupedMessage
): TrailingGroup | null {
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
  if (!inserted) return null;
  const rowid = parseRowid(inserted, 'materialization.grouped_rowid');
  try {
    insertFtsRow(sql, rowid, group.content);
  } catch (error) {
    // Some legacy/best-effort callers are not wrapped in a storage transaction.
    // Remove the content row so a retry cannot mistake a grouped-only orphan for
    // a fully indexed conflict and then stamp the projection complete.
    sql.exec('DELETE FROM chat_messages_grouped WHERE rowid = ?', rowid);
    throw error;
  }
  return { rowid, role: group.role, content: group.content };
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
function extendTrailingGroup(
  sql: SqlStorage,
  trailing: TrailingGroup,
  head: GroupedMessage
): TrailingGroup {
  const merged = trailing.content + head.content;
  sql.exec('UPDATE chat_messages_grouped SET content = ? WHERE rowid = ?', merged, trailing.rowid);
  replaceFtsRow(sql, trailing.rowid, trailing.content, merged);
  return { rowid: trailing.rowid, role: trailing.role, content: merged };
}

/** Upper bound of the tokens folded into a group, used as a mid-page checkpoint. */
function headWatermark(head: GroupedMessage): Watermark {
  return { createdAt: head.lastCreatedAt, sequence: head.lastSequence };
}

function stampIndexState(
  sql: SqlStorage,
  sessionId: string,
  indexState: string,
  watermark: Watermark | null,
  projectionComplete: boolean
): void {
  const now = Date.now();
  sql.exec(
    `UPDATE chat_sessions
     SET materialized_at = ?,
         materialized_through_created_at = ?,
         materialized_through_sequence = ?,
         search_index_state = ?,
         search_projection_version = ?,
         search_index_updated_at = ?,
         search_index_degradation_reason = NULL
     WHERE id = ?`,
    now,
    watermark?.createdAt ?? null,
    watermark?.sequence ?? null,
    indexState,
    projectionComplete ? PROJECT_SEARCH_PROJECTION_VERSION : 0,
    now,
    sessionId
  );
}

/**
 * The upper bound of a page, by MAX rather than "last in scan order".
 *
 * `chat_messages.created_at` comes from the VM agent's own clock
 * (`persistMessageBatch`) while `sequence` is assigned here at insert. They agree
 * unless a retried batch lands out of order, and taking the max of each keeps the
 * watermark a true upper bound of what was indexed.
 */
function pageWatermark(tokens: Array<ReturnType<typeof parseMaterializationToken>>): Watermark {
  return tokens.reduce<Watermark>(
    (acc, token) => ({
      createdAt: Math.max(acc.createdAt, token.createdAt),
      sequence: Math.max(acc.sequence, token.sequence),
    }),
    { createdAt: 0, sequence: 0 }
  );
}

/**
 * Group and write one page, returning the trailing group for the next page.
 *
 * `trailing` is `undefined` when it has not been read yet, `null` when the session
 * has none. Carrying it across pages matters: a same-role run spanning several
 * pages would otherwise re-read and rewrite its whole growing content per page.
 */
function writePage(
  sql: SqlStorage,
  sessionId: string,
  input: {
    tokens: Array<ReturnType<typeof parseMaterializationToken>>;
    trailing: TrailingGroup | null | undefined;
    config: MaterializationPassConfig;
  }
): TrailingGroup | null {
  const groups = groupTokens(input.tokens);
  let trailing = input.trailing;
  let index = 0;
  const head = groups[0];

  if (head && GROUPABLE_ROLES.has(head.role)) {
    if (trailing === undefined) trailing = readTrailingGroup(sql, sessionId);
    if (trailing?.role === head.role && trailing.content.length < input.config.maxGroupChars) {
      trailing = extendTrailingGroup(sql, trailing, head);
      index = 1;
      // Checkpoint immediately. Unlike `insertGroup`, extension is a plain
      // in-place UPDATE with no conflict guard, so if anything below throws — and
      // every caller catches and logs rather than failing the transition — a retry
      // re-reading these tokens would append the same text a second time. Moving
      // the watermark past the extended run first makes the retry skip it.
      stampIndexState(sql, sessionId, SEARCH_INDEX_STATE_PARTIAL, headWatermark(head), false);
    }
  }

  for (const group of groups.slice(index)) {
    trailing = insertGroup(sql, sessionId, group) ?? trailing;
  }
  return trailing ?? null;
}

/**
 * Materialize grouped messages for a session, from its watermark forward.
 *
 * Safe to call on every sleep and again on stop. Idempotent: a call with no new
 * messages and no state promotion to make writes nothing.
 *
 * The scan is paged, so peak memory is bounded by `pageRows` rather than by the
 * session's size, and the pass stops after `maxRowsPerPass` tokens — leaving
 * `search_index_state = 'partial'` and an advanced watermark, so the next sleep or
 * stop resumes exactly where this one stopped.
 */
export function materializeSession(
  sql: SqlStorage,
  sessionId: string,
  config: MaterializationPassConfig = DEFAULT_PASS_CONFIG
): void {
  const state = readMaterializationState(sql, sessionId);
  if (!state) return;
  if (state.searchIndexState === SEARCH_INDEX_STATE_PRUNED) return;

  const terminal = TERMINAL_STATUSES.has(state.status);
  const initialWatermark = resolveWatermark(state);
  let watermark = initialWatermark;
  // Read once per pass, then carried forward: a same-role run spanning several
  // pages would otherwise re-read and rewrite its whole (growing) content per page.
  let trailing: TrailingGroup | null | undefined = initialWatermark === null ? null : undefined;
  let processed = 0;
  let drained = false;

  while (processed < config.maxRowsPerPass) {
    const pageRows = Math.min(config.pageRows, config.maxRowsPerPass - processed);
    const tokens = readTokensAfter(sql, sessionId, watermark, pageRows);
    if (tokens.length === 0) {
      drained = true;
      break;
    }

    trailing = writePage(sql, sessionId, { tokens, trailing, config });
    watermark = pageWatermark(tokens);
    processed += tokens.length;
    if (tokens.length < pageRows) {
      drained = true;
      break;
    }
  }

  if (processed === 0) {
    // Nothing new. Only write if terminalization has something left to record:
    // an empty or fully-indexed session that has since stopped is now complete.
    const settledState = terminal ? SEARCH_INDEX_STATE_COMPLETE : SEARCH_INDEX_STATE_PARTIAL;
    if (
      (terminal && state.searchIndexState !== SEARCH_INDEX_STATE_COMPLETE) ||
      (state.messageCount > 0 && state.projectionVersion !== PROJECT_SEARCH_PROJECTION_VERSION)
    ) {
      stampIndexState(sql, sessionId, settledState, watermark, true);
    }
    return;
  }

  if (!drained) {
    log.info('materialization.pass_truncated', {
      sessionId,
      processed,
      maxRowsPerPass: config.maxRowsPerPass,
    });
  }

  stampIndexState(
    sql,
    sessionId,
    // A truncated pass has NOT indexed everything, so a stopped session stays
    // partial until a later pass drains it — otherwise 'complete' would lie and
    // the sweep would stop selecting a session that still has unindexed messages.
    terminal && drained ? SEARCH_INDEX_STATE_COMPLETE : SEARCH_INDEX_STATE_PARTIAL,
    watermark,
    drained
  );
}

/**
 * Selects sessions with non-system messages past their watermark.
 *
 * The three-branch disjunction below MIRRORS `resolveWatermark()` above, arm for
 * arm: no watermark at all, a legacy `materialized_at`-only watermark, and a full
 * `(created_at, sequence)` watermark. `searchMessagesLike` in `messages.ts` carries
 * a third copy of the same rule. If you change one, change all three — a sweep that
 * disagrees with the indexer either re-selects sessions forever or never selects
 * them at all, and neither shows up as an error.
 *
 * Ranked newest-updated first: the point of the index is that recent work is
 * searchable, so a truncated scan must drop the oldest sessions, not arbitrary
 * ones (rule 65).
 */
const PENDING_SESSIONS_CTE = `
  WITH candidates AS (
    SELECT s.id AS id,
           COALESCE(s.materialized_through_created_at, s.materialized_at) AS wm_created_at,
           CASE WHEN s.materialized_through_created_at IS NOT NULL
                THEN COALESCE(s.materialized_through_sequence, 0)
                WHEN s.materialized_at IS NOT NULL THEN ${SEQUENCE_ABOVE_ANY_ROW}
                ELSE -1 END AS wm_sequence
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
      AND (m.created_at, m.sequence) > (COALESCE(c.wm_created_at, 0), c.wm_sequence)
  )`;

/**
 * Composed once at module scope rather than inline at the call site.
 *
 * `sql.exec()` must receive a plain string: the AST quality gate rejects any
 * template expression inside the call, and it also counts `?` placeholders in the
 * literal parts only, so interpolating a fragment that carries its own `?` reads
 * as a placeholder/parameter mismatch. Both queries below bind every value.
 */
const PENDING_SESSIONS_COUNT_SQL = `${PENDING_SESSIONS_CTE}
  SELECT COUNT(*) AS count FROM candidates c WHERE ${PENDING_SESSIONS_PREDICATE}`;

const PENDING_SESSIONS_SELECT_SQL = `${PENDING_SESSIONS_CTE}
  SELECT c.id AS id FROM candidates c WHERE ${PENDING_SESSIONS_PREDICATE} LIMIT ?`;

/**
 * Pending sessions WITHIN the scan window, not the true backlog.
 *
 * `remaining` counts only the `scanLimit` newest-updated candidates, so it can read
 * zero while older unscanned sessions are still unindexed. Any future caller that
 * drains to zero must re-run until it stops making progress rather than trusting a
 * single zero (rule 65: disclose what the cap dropped).
 */
function countPendingSessions(sql: SqlStorage, scanLimit: number): number {
  const row = sql.exec(PENDING_SESSIONS_COUNT_SQL, scanLimit).toArray()[0];
  return row ? parseCount(row, 'materialization.remaining') : 0;
}

/**
 * Materialize sessions whose transcript has outrun their search index.
 *
 * Replaces the old `status = 'stopped' AND materialized_at IS NULL` sweep: once a
 * sleeping session can be indexed mid-life, "never indexed" is no longer the same
 * question as "has unindexed messages".
 *
 * Nothing schedules this today — ordinary sessions are indexed by their own sleep
 * and stop transitions, and this exists to drain sessions that were already asleep
 * when incremental materialization shipped. Wiring a periodic caller needs its own
 * I/O budget and candidate-escape design under `.claude/rules/47`; tracked in idea
 * `01M313TT05Q5R09D9E0ZZGW0E3`.
 */
export function materializePendingSessions(
  sql: SqlStorage,
  limit: number = DEFAULT_MATERIALIZATION_SWEEP_LIMIT,
  scanLimit: number = DEFAULT_MATERIALIZATION_SWEEP_SCAN_LIMIT,
  passConfig?: MaterializationPassConfig
): { materialized: number; errors: number; remaining: number } {
  const sessions = sql.exec(PENDING_SESSIONS_SELECT_SQL, scanLimit, limit).toArray();

  let materialized = 0;
  let errors = 0;
  for (const row of sessions) {
    try {
      materializeSession(sql, parseSessionId(row, 'materialization.batch_session'), passConfig);
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
