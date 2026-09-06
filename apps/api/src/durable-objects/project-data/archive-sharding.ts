// FILE SIZE EXCEPTION: ProjectData terminal archive migration state machine — keeping source intent, target copy/seal, canonical hash, exact-read guards, and final source-delete invariants in one module avoids cross-file transaction coupling during Fable review. See .claude/rules/18-file-size-limits.md
import { D1_MAX_BOUND_PARAMETERS } from '../../lib/d1-limits';
import { createModuleLogger, serializeError } from '../../lib/logger';
import {
  PROJECT_DATA_ARCHIVE_DEFAULT_CHUNK_BYTES,
  PROJECT_DATA_ARCHIVE_DEFAULT_CHUNK_ROWS,
  PROJECT_DATA_ARCHIVE_DEFAULT_HASH_PAGE_ROWS,
  PROJECT_DATA_ARCHIVE_DEFAULT_SESSION_GRACE_MS,
  PROJECT_DATA_ARCHIVE_MAX_CHUNK_BYTES,
  PROJECT_DATA_ARCHIVE_MAX_HASH_PAGE_ROWS,
  PROJECT_DATA_ARCHIVE_SOURCE_INTENT_STATES,
  PROJECT_DATA_ARCHIVE_TABLES,
  PROJECT_DATA_ARCHIVE_TARGET_STATES,
  type ProjectDataArchiveChunk,
  type ProjectDataArchiveExactReadInput,
  type ProjectDataArchiveOwnerRef,
  type ProjectDataArchiveRow,
  type ProjectDataArchiveSourceIntentState,
  type ProjectDataArchiveTableName,
  type ProjectDataArchiveTargetState,
} from '../../project-data-archive/contract';
import {
  byteLength,
  canonicalizeArchiveRow,
  canonicalRowsSha256,
  compareArchiveStrings,
  createCanonicalRowsHasher,
  sha256Hex,
} from '../../project-data-archive/hashing';
import * as messages from './messages';
import type {
  ArchivedToolPayloadListResult,
  MessageToolContentResult,
} from './tool-payload-archive';
import * as toolPayloadArchive from './tool-payload-archive';
import type { Env } from './types';

const log = createModuleLogger('project_data.archive_sharding');
const PENDING_TERMINAL_VERSION_SHA256 = 'pending';

export class ProjectDataArchiveInvariantError extends Error {
  readonly code = 'PROJECT_DATA_ARCHIVE_INVARIANT';

  constructor(
    readonly reason: string,
    message: string
  ) {
    super(message);
    this.name = 'ProjectDataArchiveInvariantError';
  }
}

type ChunkTableSpec = {
  columns: readonly string[];
  keyColumn: string;
  orderBy: string;
  cursorPredicate: string;
  cursorValues: (cursor: string) => Array<string | number>;
  cursorFromRow: (row: Record<string, unknown>) => string;
};

const CHAT_SESSION_ANCHOR_COLUMNS = [
  'id',
  'workspace_id',
  'task_id',
  'created_by_user_id',
  'topic',
  'status',
  'message_count',
  'started_at',
  'ended_at',
  'created_at',
  'updated_at',
  'agent_completed_at',
  'materialized_at',
  'terminal_reconcile_deferred_until',
  'terminal_reconcile_defer_reason',
  'search_index_state',
  'search_index_updated_at',
  'search_index_degradation_reason',
] as const;

const ARCHIVE_TABLE_SPECS: Record<ProjectDataArchiveTableName, ChunkTableSpec> = {
  chat_messages: {
    columns: [
      'id',
      'session_id',
      'role',
      'content',
      'tool_metadata',
      'created_at',
      'sequence',
      'origin',
    ],
    keyColumn: 'id',
    orderBy: 'created_at ASC, sequence ASC, id ASC',
    cursorPredicate:
      '(created_at > ? OR (created_at = ? AND sequence > ?) OR (created_at = ? AND sequence = ? AND id > ?))',
    cursorValues: (cursor) => {
      const parts = decodeCursor(cursor, 3);
      const createdAt = Number(cursorPart(parts, 0));
      const sequence = Number(cursorPart(parts, 1));
      const id = cursorPart(parts, 2);
      return [createdAt, createdAt, sequence, createdAt, sequence, id];
    },
    cursorFromRow: (row) =>
      encodeCursor([
        strictInteger(row.created_at, 'message.created_at'),
        strictInteger(row.sequence, 'message.sequence'),
        strictString(row.id, 'message.id'),
      ]),
  },
  chat_messages_grouped: {
    columns: ['id', 'session_id', 'role', 'content', 'created_at'],
    keyColumn: 'id',
    orderBy: 'created_at ASC, id ASC',
    cursorPredicate: '(created_at > ? OR (created_at = ? AND id > ?))',
    cursorValues: (cursor) => {
      const parts = decodeCursor(cursor, 2);
      const createdAt = Number(cursorPart(parts, 0));
      const id = cursorPart(parts, 1);
      return [createdAt, createdAt, id];
    },
    cursorFromRow: (row) =>
      encodeCursor([
        strictInteger(row.created_at, 'grouped.created_at'),
        strictString(row.id, 'grouped.id'),
      ]),
  },
  tool_payload_archives: {
    columns: [
      'message_id',
      'session_id',
      'r2_key',
      'content_bytes',
      'tool_metadata_bytes',
      'archived_at',
      'message_created_at',
      'message_sequence',
      'archive_version',
      'archive_body_bytes',
      'archive_body_sha256',
      'root_object_bytes',
      'root_object_sha256',
      'verified_object_count',
      'source_tool_metadata_sha256',
    ],
    keyColumn: 'message_id',
    orderBy: 'message_created_at ASC, message_sequence ASC, message_id ASC',
    cursorPredicate:
      '(message_created_at > ? OR (message_created_at = ? AND message_sequence > ?) OR (message_created_at = ? AND message_sequence = ? AND message_id > ?))',
    cursorValues: (cursor) => {
      const parts = decodeCursor(cursor, 3);
      const createdAt = Number(cursorPart(parts, 0));
      const sequence = Number(cursorPart(parts, 1));
      const id = cursorPart(parts, 2);
      return [createdAt, createdAt, sequence, createdAt, sequence, id];
    },
    cursorFromRow: (row) =>
      encodeCursor([
        strictInteger(row.message_created_at, 'tool_archive.message_created_at'),
        strictInteger(row.message_sequence, 'tool_archive.message_sequence'),
        strictString(row.message_id, 'tool_archive.message_id'),
      ]),
  },
};

export type ArchiveSourcePrepareInput = {
  projectId: string;
  sessionId: string;
  migrationId: string;
  sourceOwnerName: string;
  targetOwnerName: string;
  targetGeneration: number;
  sourceIntentToken: string;
  now: number;
  minTerminalAgeMs?: number;
  /**
   * Rows per statement for hash and grouped-row scans. Owned by the ProjectData DO, which
   * fills it from `PROJECT_DATA_ARCHIVE_HASH_PAGE_ROWS`; coordinators never set it. It lives
   * on the input type (not a second parameter) so the DO can override it uniformly.
   */
  hashPageRows?: number;
};

export type ArchiveSourcePrepareResult = {
  idempotent: boolean;
  sourceIntentToken: string;
  terminalVersionSha256: string;
  lastMessageAt: number | null;
  messageCount: number;
  sessionRow: ProjectDataArchiveRow;
  databaseSizeBytes: number;
};

export type ArchiveSourceInspectIntentInput = {
  projectId: string;
  sessionId: string;
  migrationId: string;
  sourceOwnerName: string;
  targetOwnerName: string;
  targetGeneration: number;
};

export type ArchiveSourceInspectIntentResult =
  | {
      exists: false;
      databaseSizeBytes: number;
    }
  | {
      exists: true;
      state: ProjectDataArchiveSourceIntentState;
      sourceIntentToken: string;
      terminalVersionSha256: string;
      targetAggregateSha256: string | null;
      r2ManifestKey: string | null;
      lastMessageAt: number | null;
      messageCount: number;
      sourceDeletedAt: number | null;
      databaseSizeBeforeBytes: number | null;
      databaseSizeAfterBytes: number | null;
      databaseSizeBytes: number;
    };

export type ArchiveSourceExportChunkInput = {
  projectId: string;
  sessionId: string;
  migrationId: string;
  sourceOwnerName: string;
  targetOwnerName: string;
  targetGeneration: number;
  sourceIntentToken: string;
  tableName: ProjectDataArchiveTableName;
  ordinal: number;
  cursor?: string | null;
  maxRows?: number;
  maxBytes?: number;
};

export type ArchiveTargetPrepareInput = {
  projectId: string;
  sessionId: string;
  migrationId: string;
  sourceOwnerName: string;
  targetOwnerName: string;
  targetGeneration: number;
  sourceIntentToken: string;
  terminalVersionSha256: string;
  sessionRow: ProjectDataArchiveRow;
  expectedMessageCount: number;
  now: number;
};

export type ArchiveTargetPrepareResult = {
  idempotent: boolean;
  state: ProjectDataArchiveTargetState;
};

export type ArchiveTargetCommitChunkInput = ProjectDataArchiveChunk & {
  now: number;
};

export type ArchiveTargetCommitChunkResult = {
  idempotent: boolean;
  tableName: ProjectDataArchiveTableName;
  rowCount: number;
  sha256: string;
};

export type ArchiveTargetSealInput = {
  projectId: string;
  sessionId: string;
  migrationId: string;
  sourceOwnerName: string;
  targetOwnerName: string;
  targetGeneration: number;
  sourceIntentToken: string;
  terminalVersionSha256: string;
  expectedChunkHashes: string[];
  now: number;
  /** See `ArchiveSourcePrepareInput.hashPageRows`: DO-owned page size, never set by coordinators. */
  hashPageRows?: number;
};

export type ArchiveTargetSealResult = {
  aggregateSha256: string;
  messageCount: number;
  groupedCount: number;
  toolArchiveCount: number;
};

export type ArchiveSourceFinalizeDeleteInput = {
  projectId: string;
  sessionId: string;
  migrationId: string;
  sourceOwnerName: string;
  targetOwnerName: string;
  targetGeneration: number;
  sourceIntentToken: string;
  expectedTerminalVersionSha256: string;
  targetAggregateSha256: string;
  r2ManifestKey: string;
  now: number;
  minTerminalAgeMs?: number;
  /** See `ArchiveSourcePrepareInput.hashPageRows`: DO-owned page size, never set by coordinators. */
  hashPageRows?: number;
};

export type ArchiveSourceFinalizeDeleteResult = {
  idempotent: boolean;
  lastMessageAt: number | null;
  messagesDeleted: number;
  groupedRowsDeleted: number;
  ftsRowsDeleted: number;
  toolArchiveRowsDeleted: number;
  databaseSizeBeforeBytes: number;
  databaseSizeAfterBytes: number;
};

export type ArchiveTargetInspectInput = {
  projectId: string;
  sessionId: string;
  migrationId: string | null;
  targetOwnerName: string;
  targetGeneration: number;
};

export type ArchiveTargetInspectResult = {
  state: ProjectDataArchiveTargetState;
  terminalVersionSha256: string;
  aggregateSha256: string | null;
  messageCount: number;
  groupedCount: number;
  toolArchiveCount: number;
  chunks: Array<{
    tableName: ProjectDataArchiveTableName;
    ordinal: number;
    sha256: string;
    rowCount: number;
    byteCount: number;
  }>;
  sessionRow: ProjectDataArchiveRow;
  databaseSizeBytes: number;
};

export type ArchiveTargetExportChunkInput = {
  projectId: string;
  sessionId: string;
  migrationId: string | null;
  targetOwnerName: string;
  targetGeneration: number;
  tableName: ProjectDataArchiveTableName;
  ordinal: number;
  cursor?: string | null;
  maxRows?: number;
  maxBytes?: number;
};

export type ArchiveSourceRestoreChunkInput = ProjectDataArchiveChunk & {
  sourceIntentToken: string;
  now: number;
};

export type ArchiveSourceRestoreChunkResult = {
  tableName: ProjectDataArchiveTableName;
  rowCount: number;
  sha256: string;
  idempotent: boolean;
};

type TerminalVersion = {
  sha256: string;
  lastMessageAt: number | null;
  messageCount: number;
  sessionRow: ProjectDataArchiveRow;
};

type ArchiveSearchResult = {
  id: string;
  sessionId: string;
  role: string;
  snippet: string;
  createdAt: number;
  sessionTopic: string | null;
  sessionTaskId: string | null;
};

type ArchiveSearchRow = {
  id?: unknown;
  session_id?: unknown;
  role?: unknown;
  content?: unknown;
  created_at?: unknown;
  session_topic?: unknown;
  session_task_id?: unknown;
};

function strictString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ProjectDataArchiveInvariantError('invalid_row_value', `${field} must be a string`);
  }
  return value;
}

function strictInteger(value: unknown, field: string): number {
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string'
        ? Number.parseInt(value, 10)
        : Number.NaN;
  if (!Number.isSafeInteger(parsed)) {
    throw new ProjectDataArchiveInvariantError('invalid_row_value', `${field} must be an integer`);
  }
  return parsed;
}

function toArchiveRow(
  row: Record<string, unknown>,
  columns: readonly string[]
): ProjectDataArchiveRow {
  const out: ProjectDataArchiveRow = {};
  for (const column of columns) {
    const value = row[column] ?? null;
    if (value === null || typeof value === 'string' || typeof value === 'number') {
      out[column] = value;
      continue;
    }
    throw new ProjectDataArchiveInvariantError(
      'unsupported_archive_value',
      `ProjectData archive column ${column} is not serializable`
    );
  }
  return out;
}

function decodeCursor(cursor: string, parts: number): string[] {
  const decoded = JSON.parse(cursor) as unknown;
  if (
    !Array.isArray(decoded) ||
    decoded.length !== parts ||
    decoded.some((part) => part === null)
  ) {
    throw new ProjectDataArchiveInvariantError(
      'invalid_cursor',
      'Invalid ProjectData archive cursor'
    );
  }
  return decoded.map((part) => String(part));
}

function cursorPart(parts: string[], index: number): string {
  const value = parts[index];
  if (value === undefined) {
    throw new ProjectDataArchiveInvariantError(
      'invalid_cursor',
      'Invalid ProjectData archive cursor'
    );
  }
  return value;
}

function encodeCursor(values: Array<string | number>): string {
  return JSON.stringify(values);
}

function mapArchiveSearchRow(row: ArchiveSearchRow, query: string): ArchiveSearchResult {
  const content = typeof row.content === 'string' ? row.content : '';
  return {
    id: strictString(row.id, 'archive_search.id'),
    sessionId: strictString(row.session_id, 'archive_search.session_id'),
    role: strictString(row.role, 'archive_search.role'),
    snippet: messages.extractSnippet(content, query),
    createdAt: strictInteger(row.created_at, 'archive_search.created_at'),
    sessionTopic: typeof row.session_topic === 'string' ? row.session_topic : null,
    sessionTaskId: typeof row.session_task_id === 'string' ? row.session_task_id : null,
  };
}

function normalizePositiveInteger(
  value: number | undefined,
  fallback: number,
  max: number
): number {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) {
    return Math.min(value, max);
  }
  return fallback;
}

/**
 * Rows per statement for streaming hash and grouped-row loops. Read from the Worker env by
 * the ProjectData DO; pure helpers take it as an explicit argument so tests can pin it.
 */
export function resolveArchiveHashPageRows(
  env: { PROJECT_DATA_ARCHIVE_HASH_PAGE_ROWS?: string } | undefined
): number {
  const parsed = Number.parseInt(env?.PROJECT_DATA_ARCHIVE_HASH_PAGE_ROWS ?? '', 10);
  return normalizePositiveInteger(
    Number.isSafeInteger(parsed) ? parsed : undefined,
    PROJECT_DATA_ARCHIVE_DEFAULT_HASH_PAGE_ROWS,
    PROJECT_DATA_ARCHIVE_MAX_HASH_PAGE_ROWS
  );
}

function resolveHashPageRows(value: number | undefined): number {
  return normalizePositiveInteger(
    value,
    PROJECT_DATA_ARCHIVE_DEFAULT_HASH_PAGE_ROWS,
    PROJECT_DATA_ARCHIVE_MAX_HASH_PAGE_ROWS
  );
}

/**
 * Page statement for `forEachGroupedRowPaged`. Seeks on the indexed
 * `idx_grouped_messages_session (session_id, created_at)` order with `id` as the tie-break
 * (the same total order `ARCHIVE_TABLE_SPECS.chat_messages_grouped` uses), so each page is an
 * index range scan rather than a per-page sort of the whole session. Exported for the plan test.
 */
export const GROUPED_ROW_PAGE_SQL = `SELECT rowid, id, content, created_at FROM chat_messages_grouped
         WHERE session_id = ? AND (created_at > ? OR (created_at = ? AND id > ?))
         ORDER BY created_at ASC, id ASC
         LIMIT ?`;

/**
 * Visit every grouped row of a session in bounded pages, so a session with hundreds of
 * thousands of rows never materialises in one statement. Rows may be deleted inside
 * `visit`: the next page seeks past the last `(created_at, id)` seen, not by offset.
 *
 * The page still selects SQLite `rowid` because the FTS5 external-content index is keyed by
 * rowid, and the delete markers `rebuildTargetFts` / `abandonArchiveTargetSession` emit need
 * it. Paging by `rowid` itself is NOT served by any index on this table (a bare
 * `ORDER BY rowid` plans as a temp b-tree over the whole session on every page), which is
 * why the seek key is the indexed `(created_at, id)` pair instead.
 */
function forEachGroupedRowPaged(
  sql: SqlStorage,
  sessionId: string,
  pageRows: number,
  visit: (row: Record<string, unknown>) => void
): void {
  let lastCreatedAt = -1;
  let lastId = '';
  for (;;) {
    const page = sql
      .exec(GROUPED_ROW_PAGE_SQL, sessionId, lastCreatedAt, lastCreatedAt, lastId, pageRows)
      .toArray();
    for (const row of page) visit(row);
    if (page.length < pageRows) break;
    const tail = page[page.length - 1];
    if (!tail) break;
    lastCreatedAt = strictInteger(tail.created_at, 'grouped.created_at');
    lastId = strictString(tail.id, 'grouped.id');
  }
}

function databaseSize(sql: SqlStorage): number {
  return typeof sql.databaseSize === 'number' && Number.isFinite(sql.databaseSize)
    ? sql.databaseSize
    : 0;
}

function validateRootSourceOwner(input: {
  projectId: string;
  sourceOwnerName: string;
  targetOwnerName: string;
  targetGeneration: number;
}): void {
  if (input.sourceOwnerName !== input.projectId) {
    throw new ProjectDataArchiveInvariantError(
      'source_owner_mismatch',
      'ProjectData archive source owner must be the root ProjectData owner'
    );
  }
  if (input.targetOwnerName === input.sourceOwnerName || input.targetGeneration <= 0) {
    throw new ProjectDataArchiveInvariantError(
      'target_owner_mismatch',
      'ProjectData archive target owner must be a non-root positive generation'
    );
  }
}

function validateTableName(tableName: ProjectDataArchiveTableName): ChunkTableSpec {
  if (!PROJECT_DATA_ARCHIVE_TABLES.includes(tableName)) {
    throw new ProjectDataArchiveInvariantError(
      'unknown_archive_table',
      'ProjectData archive table is not in the sharding inventory'
    );
  }
  return ARCHIVE_TABLE_SPECS[tableName];
}

function validateIntentState(value: unknown): ProjectDataArchiveSourceIntentState {
  if (
    typeof value === 'string' &&
    PROJECT_DATA_ARCHIVE_SOURCE_INTENT_STATES.includes(value as ProjectDataArchiveSourceIntentState)
  ) {
    return value as ProjectDataArchiveSourceIntentState;
  }
  throw new ProjectDataArchiveInvariantError(
    'unknown_source_intent_state',
    'ProjectData archive source intent has an unknown state'
  );
}

function optionalNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function optionalInteger(value: unknown): number | null {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10);
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  return null;
}

function validateTargetState(value: unknown): ProjectDataArchiveTargetState {
  if (
    typeof value === 'string' &&
    PROJECT_DATA_ARCHIVE_TARGET_STATES.includes(value as ProjectDataArchiveTargetState)
  ) {
    return value as ProjectDataArchiveTargetState;
  }
  throw new ProjectDataArchiveInvariantError(
    'unknown_target_state',
    'ProjectData archive target state is unknown'
  );
}

function readSessionAnchor(sql: SqlStorage, sessionId: string): ProjectDataArchiveRow | null {
  const columns = CHAT_SESSION_ANCHOR_COLUMNS.join(', ');
  const query = `SELECT ${columns} FROM chat_sessions WHERE id = ?`;
  const row = sql.exec(query, sessionId).toArray()[0] ?? null;
  return row ? toArchiveRow(row, CHAT_SESSION_ANCHOR_COLUMNS) : null;
}

function countRows(sql: SqlStorage, query: string, ...params: Array<string | number>): number {
  const row = sql.exec(query, ...params).toArray()[0];
  const count = row?.count ?? row?.cnt;
  if (typeof count === 'number') return count;
  if (typeof count === 'string') return Number.parseInt(count, 10);
  return 0;
}

function readLastMessageAt(sql: SqlStorage, sessionId: string): number | null {
  const row = sql
    .exec(
      'SELECT MAX(created_at) AS last_message_at FROM chat_messages WHERE session_id = ?',
      sessionId
    )
    .toArray()[0];
  const value = row?.last_message_at;
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : null;
}

function assertEligibleTerminalSource(
  sql: SqlStorage,
  sessionId: string,
  now: number,
  minTerminalAgeMs = PROJECT_DATA_ARCHIVE_DEFAULT_SESSION_GRACE_MS
): void {
  const session = readSessionAnchor(sql, sessionId);
  if (!session) {
    throw new ProjectDataArchiveInvariantError(
      'session_missing',
      'ProjectData archive source session does not exist'
    );
  }
  if (session.status !== 'stopped' && session.status !== 'failed') {
    throw new ProjectDataArchiveInvariantError(
      'session_not_terminal',
      'ProjectData archive only moves terminal sessions'
    );
  }
  const endedAt = strictInteger(session.ended_at, 'chat_sessions.ended_at');
  if (now - endedAt < minTerminalAgeMs) {
    throw new ProjectDataArchiveInvariantError(
      'terminal_grace_not_elapsed',
      'ProjectData archive terminal grace has not elapsed'
    );
  }
  if (
    countRows(
      sql,
      "SELECT COUNT(*) AS count FROM acp_sessions WHERE chat_session_id = ? AND status IN ('assigned', 'running', 'started')",
      sessionId
    ) > 0
  ) {
    throw new ProjectDataArchiveInvariantError(
      'active_acp_session',
      'ProjectData archive refuses sessions with active ACP runtime rows'
    );
  }
  if (
    countRows(
      sql,
      `SELECT COUNT(*) AS count
       FROM session_state ss
       LEFT JOIN acp_sessions acp ON acp.id = ss.session_id
       WHERE (ss.session_id = ? OR acp.chat_session_id = ?)
         AND (
           ss.activity IN ('prompting', 'recovering', 'error')
           OR ss.runtime_work_state IN ('active', 'settling')
         )`,
      sessionId,
      sessionId
    ) > 0
  ) {
    throw new ProjectDataArchiveInvariantError(
      'active_session_state',
      'ProjectData archive refuses sessions with active session_state rows'
    );
  }
  if (
    countRows(
      sql,
      "SELECT COUNT(*) AS count FROM task_wait_subscriptions WHERE parent_session_id = ? AND state = 'active'",
      sessionId
    ) > 0
  ) {
    throw new ProjectDataArchiveInvariantError(
      'active_task_wait',
      'ProjectData archive refuses sessions with active task wait subscriptions'
    );
  }
  if (
    countRows(
      sql,
      'SELECT COUNT(*) AS count FROM idle_cleanup_schedule WHERE session_id = ? AND terminal_state IS NULL',
      sessionId
    ) > 0
  ) {
    throw new ProjectDataArchiveInvariantError(
      'active_idle_cleanup',
      'ProjectData archive refuses sessions with active idle-cleanup schedule rows'
    );
  }
  if (
    countRows(
      sql,
      'SELECT COUNT(*) AS count FROM session_attention_markers WHERE session_id = ? AND resolved_at IS NULL',
      sessionId
    ) > 0
  ) {
    throw new ProjectDataArchiveInvariantError(
      'unresolved_attention',
      'ProjectData archive refuses sessions with unresolved attention markers'
    );
  }
  if (
    countRows(
      sql,
      'SELECT COUNT(*) AS count FROM comment_threads WHERE session_id = ?',
      sessionId
    ) > 0 ||
    countRows(
      sql,
      'SELECT COUNT(*) AS count FROM comment_replies WHERE session_id = ?',
      sessionId
    ) > 0
  ) {
    throw new ProjectDataArchiveInvariantError(
      'message_comments_present',
      'ProjectData archive refuses sessions with message comments to avoid cascade deletion'
    );
  }
  if (
    countRows(
      sql,
      `SELECT COUNT(*) AS count
       FROM tool_payload_cleanup_attempts attempts
       JOIN chat_messages messages ON messages.id = attempts.message_id
       WHERE messages.session_id = ?
         AND attempts.status = 'retryable_failure'`,
      sessionId
    ) > 0
  ) {
    throw new ProjectDataArchiveInvariantError(
      'tool_payload_cleanup_incomplete',
      'ProjectData archive refuses sessions while retryable tool-payload cleanup is unresolved'
    );
  }
}

/**
 * Stream a table's canonical-row digest for one session.
 *
 * Reads at most `pageRows` rows per statement using the table spec's seek cursor, so
 * memory is bounded by page size rather than session size. The digest is byte-identical
 * to `canonicalRowsSha256` over the same rows (see `createCanonicalRowsHasher`), which is
 * what keeps every previously recorded terminal-version proof valid.
 *
 * Production incident: the one-shot form loaded a 100,000-message session with
 * `toArray()` and reset the ProjectData object on its memory ceiling; a tool-heavy
 * 9,906-message session did the same. The object's memory limit is a platform ceiling the
 * better-sqlite3 unit harness does not enforce (rule 69), so the regression test asserts
 * the page shape, not the failure.
 */
async function tableAggregateSha256(
  sql: SqlStorage,
  tableName: ProjectDataArchiveTableName,
  sessionId: string,
  pageRows: number
): Promise<string> {
  const spec = validateTableName(tableName);
  const hasher = createCanonicalRowsHasher(spec.columns);
  let cursor: string | null = null;
  for (;;) {
    let query = `SELECT ${spec.columns.join(', ')} FROM ${tableName} WHERE session_id = ?`;
    const params: Array<string | number> = [sessionId];
    if (cursor) {
      query += ` AND ${spec.cursorPredicate}`;
      params.push(...spec.cursorValues(cursor));
    }
    query += ` ORDER BY ${spec.orderBy} LIMIT ?`;
    params.push(pageRows);
    const page = sql.exec(query, ...params).toArray();
    for (const raw of page) hasher.update(toArchiveRow(raw, spec.columns));
    if (page.length < pageRows) break;
    const tail = page[page.length - 1];
    if (!tail) break;
    cursor = spec.cursorFromRow(tail);
  }
  return hasher.digestHex();
}

export type ComputeTerminalVersionOptions = {
  hashPageRows?: number;
};

export async function computeTerminalVersion(
  sql: SqlStorage,
  sessionId: string,
  options: ComputeTerminalVersionOptions = {}
): Promise<TerminalVersion> {
  const pageRows = resolveHashPageRows(options.hashPageRows);
  const sessionRow = readSessionAnchor(sql, sessionId);
  if (!sessionRow) {
    throw new ProjectDataArchiveInvariantError(
      'session_missing',
      'Cannot compute ProjectData archive terminal version for a missing session'
    );
  }
  const messageCount = countRows(
    sql,
    'SELECT COUNT(*) AS count FROM chat_messages WHERE session_id = ?',
    sessionId
  );
  const lastMessageAt = readLastMessageAt(sql, sessionId);
  const components = [
    `chat_session:${canonicalizeArchiveRow(CHAT_SESSION_ANCHOR_COLUMNS, sessionRow)}`,
    `chat_messages:${await tableAggregateSha256(sql, 'chat_messages', sessionId, pageRows)}`,
    `chat_messages_grouped:${await tableAggregateSha256(sql, 'chat_messages_grouped', sessionId, pageRows)}`,
    `tool_payload_archives:${await tableAggregateSha256(sql, 'tool_payload_archives', sessionId, pageRows)}`,
    `comments:${countRows(sql, 'SELECT COUNT(*) AS count FROM comment_threads WHERE session_id = ?', sessionId)}:${countRows(
      sql,
      'SELECT COUNT(*) AS count FROM comment_replies WHERE session_id = ?',
      sessionId
    )}`,
    `last_message_at:${lastMessageAt ?? 'null'}`,
  ];
  return {
    sha256: await sha256Hex(components.join('\n')),
    lastMessageAt,
    messageCount,
    sessionRow,
  };
}

function readSourceIntent(sql: SqlStorage, sessionId: string): Record<string, unknown> | null {
  return (
    sql
      .exec('SELECT * FROM project_data_archive_source_intents WHERE session_id = ?', sessionId)
      .toArray()[0] ?? null
  );
}

function assertSameSourceIntentMigration(
  intent: Record<string, unknown> | null,
  input: {
    projectId: string;
    sessionId: string;
    migrationId: string;
    sourceOwnerName: string;
    targetOwnerName: string;
    targetGeneration: number;
  }
): ProjectDataArchiveSourceIntentState {
  if (!intent) {
    throw new ProjectDataArchiveInvariantError(
      'source_intent_missing',
      'ProjectData archive source intent is missing'
    );
  }
  if (
    intent.project_id !== input.projectId ||
    intent.migration_id !== input.migrationId ||
    intent.source_owner_name !== input.sourceOwnerName ||
    intent.target_owner_name !== input.targetOwnerName ||
    intent.target_generation !== input.targetGeneration
  ) {
    throw new ProjectDataArchiveInvariantError(
      'source_intent_mismatch',
      'ProjectData archive source intent identity mismatch'
    );
  }
  return validateIntentState(intent.state);
}

function assertMatchingSourceIntent(
  intent: Record<string, unknown> | null,
  input: {
    projectId: string;
    sessionId: string;
    migrationId: string;
    sourceOwnerName: string;
    targetOwnerName: string;
    targetGeneration: number;
    sourceIntentToken: string;
  }
): ProjectDataArchiveSourceIntentState {
  const state = assertSameSourceIntentMigration(intent, input);
  if (intent?.source_intent_token !== input.sourceIntentToken) {
    throw new ProjectDataArchiveInvariantError(
      'source_intent_mismatch',
      'ProjectData archive source intent token mismatch'
    );
  }
  return state;
}

function isActiveSourceIntentState(state: ProjectDataArchiveSourceIntentState): boolean {
  return state !== 'rehome_exported';
}

function reattachSourceIntentToken(
  sql: SqlStorage,
  input: ArchiveSourcePrepareInput,
  state: ProjectDataArchiveSourceIntentState
): void {
  if (state === 'source_deleted' || state === 'rehome_exported') return;
  sql.exec(
    `UPDATE project_data_archive_source_intents
     SET source_intent_token = ?, updated_at = ?
     WHERE session_id = ?
       AND project_id = ?
       AND migration_id = ?
       AND state = ?`,
    input.sourceIntentToken,
    input.now,
    input.sessionId,
    input.projectId,
    input.migrationId,
    state
  );
}

export function inspectArchiveSourceIntent(
  sql: SqlStorage,
  input: ArchiveSourceInspectIntentInput
): ArchiveSourceInspectIntentResult {
  validateRootSourceOwner(input);
  const intent = readSourceIntent(sql, input.sessionId);
  if (!intent) return { exists: false, databaseSizeBytes: databaseSize(sql) };
  const state = assertSameSourceIntentMigration(intent, input);
  return {
    exists: true,
    state,
    sourceIntentToken: strictString(
      intent.source_intent_token,
      'source_intent.source_intent_token'
    ),
    terminalVersionSha256: strictString(
      intent.terminal_version_sha256,
      'source_intent.terminal_version_sha256'
    ),
    targetAggregateSha256: optionalNonEmptyString(intent.target_aggregate_sha256),
    r2ManifestKey: optionalNonEmptyString(intent.recovery_manifest_key),
    lastMessageAt: optionalInteger(intent.last_message_at),
    messageCount: optionalInteger(intent.message_count) ?? 0,
    sourceDeletedAt: optionalInteger(intent.source_deleted_at),
    databaseSizeBeforeBytes: optionalInteger(intent.source_database_size_before),
    databaseSizeAfterBytes: optionalInteger(intent.source_database_size_after),
    databaseSizeBytes: databaseSize(sql),
  };
}

export async function prepareArchiveSourceIntent(
  sql: SqlStorage,
  input: ArchiveSourcePrepareInput
): Promise<ArchiveSourcePrepareResult> {
  validateRootSourceOwner(input);
  const minTerminalAgeMs = input.minTerminalAgeMs ?? PROJECT_DATA_ARCHIVE_DEFAULT_SESSION_GRACE_MS;
  assertEligibleTerminalSource(sql, input.sessionId, input.now, minTerminalAgeMs);
  const existing = readSourceIntent(sql, input.sessionId);
  if (!existing) {
    sql.exec(
      `INSERT INTO project_data_archive_source_intents (
         session_id, project_id, migration_id, source_owner_name, target_owner_name,
         target_generation, source_intent_token, state, terminal_version_sha256,
         last_message_at, message_count, prepared_at, created_at, updated_at
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, 'intent_prepared', ?, NULL, 0, ?, ?, ?)`,
      input.sessionId,
      input.projectId,
      input.migrationId,
      input.sourceOwnerName,
      input.targetOwnerName,
      input.targetGeneration,
      input.sourceIntentToken,
      PENDING_TERMINAL_VERSION_SHA256,
      input.now,
      input.now,
      input.now
    );
  }
  const terminalVersion = await computeTerminalVersion(sql, input.sessionId, {
    hashPageRows: input.hashPageRows,
  });
  if (existing) {
    const state = assertSameSourceIntentMigration(existing, input);
    if (state === 'source_deleted') {
      throw new ProjectDataArchiveInvariantError(
        'source_already_deleted',
        'ProjectData archive source payload has already been deleted'
      );
    }
    if (state === 'rehome_exported') {
      throw new ProjectDataArchiveInvariantError(
        'source_rehome_exported',
        'ProjectData archive source intent has already been re-homed or copied back'
      );
    }
    if (
      existing.terminal_version_sha256 !== PENDING_TERMINAL_VERSION_SHA256 &&
      existing.terminal_version_sha256 !== terminalVersion.sha256
    ) {
      throw new ProjectDataArchiveInvariantError(
        'terminal_version_changed',
        'ProjectData archive terminal version changed after source intent'
      );
    }
    if (existing.source_intent_token !== input.sourceIntentToken) {
      reattachSourceIntentToken(sql, input, state);
    }
    sql.exec(
      `UPDATE project_data_archive_source_intents
       SET terminal_version_sha256 = ?,
           last_message_at = ?,
           message_count = ?,
           updated_at = ?
       WHERE session_id = ?
         AND project_id = ?
         AND migration_id = ?
         AND state = ?`,
      terminalVersion.sha256,
      terminalVersion.lastMessageAt,
      terminalVersion.messageCount,
      input.now,
      input.sessionId,
      input.projectId,
      input.migrationId,
      state
    );
    return {
      idempotent: true,
      sourceIntentToken: input.sourceIntentToken,
      terminalVersionSha256: terminalVersion.sha256,
      lastMessageAt: terminalVersion.lastMessageAt,
      messageCount: terminalVersion.messageCount,
      sessionRow: terminalVersion.sessionRow,
      databaseSizeBytes: databaseSize(sql),
    };
  }
  sql.exec(
    `UPDATE project_data_archive_source_intents
     SET terminal_version_sha256 = ?,
         last_message_at = ?,
         message_count = ?,
         updated_at = ?
     WHERE session_id = ?
       AND project_id = ?
       AND migration_id = ?
       AND source_intent_token = ?
       AND state = 'intent_prepared'`,
    terminalVersion.sha256,
    terminalVersion.lastMessageAt,
    terminalVersion.messageCount,
    input.now,
    input.sessionId,
    input.projectId,
    input.migrationId,
    input.sourceIntentToken
  );

  return {
    idempotent: false,
    sourceIntentToken: input.sourceIntentToken,
    terminalVersionSha256: terminalVersion.sha256,
    lastMessageAt: terminalVersion.lastMessageAt,
    messageCount: terminalVersion.messageCount,
    sessionRow: terminalVersion.sessionRow,
    databaseSizeBytes: databaseSize(sql),
  };
}

export async function exportArchiveChunk(
  sql: SqlStorage,
  input: ArchiveSourceExportChunkInput
): Promise<ProjectDataArchiveChunk> {
  validateRootSourceOwner(input);
  const state = assertMatchingSourceIntent(readSourceIntent(sql, input.sessionId), input);
  if (state === 'source_deleted') {
    throw new ProjectDataArchiveInvariantError(
      'source_deleted',
      'ProjectData archive source read failed closed because the source payload is deleted'
    );
  }
  return exportArchiveRowsChunk(sql, input);
}

function validateTargetOwner(
  row: Record<string, unknown> | null,
  input: {
    projectId: string;
    sessionId: string;
    migrationId: string | null;
    targetOwnerName: string;
    targetGeneration: number;
  }
): ProjectDataArchiveTargetState {
  if (!row) {
    throw new ProjectDataArchiveInvariantError(
      'target_session_missing',
      'ProjectData archive target session is missing'
    );
  }
  if (
    row.project_id !== input.projectId ||
    row.session_id !== input.sessionId ||
    (input.migrationId !== null && row.migration_id !== input.migrationId) ||
    row.owner_name !== input.targetOwnerName ||
    row.generation !== input.targetGeneration
  ) {
    throw new ProjectDataArchiveInvariantError(
      'target_owner_mismatch',
      'ProjectData archive target owner identity mismatch'
    );
  }
  return validateTargetState(row.state);
}

function readTargetSession(sql: SqlStorage, sessionId: string): Record<string, unknown> | null {
  return (
    sql
      .exec('SELECT * FROM project_data_archive_target_sessions WHERE session_id = ?', sessionId)
      .toArray()[0] ?? null
  );
}

export function prepareArchiveTarget(
  sql: SqlStorage,
  input: ArchiveTargetPrepareInput
): ArchiveTargetPrepareResult {
  if (input.targetOwnerName === input.sourceOwnerName || input.targetGeneration <= 0) {
    throw new ProjectDataArchiveInvariantError(
      'target_owner_mismatch',
      'ProjectData archive target owner must be non-root'
    );
  }
  const existing = readTargetSession(sql, input.sessionId);
  if (existing) {
    const state = validateTargetOwner(existing, {
      projectId: input.projectId,
      sessionId: input.sessionId,
      migrationId: input.migrationId,
      targetOwnerName: input.targetOwnerName,
      targetGeneration: input.targetGeneration,
    });
    if (existing.terminal_version_sha256 !== input.terminalVersionSha256) {
      throw new ProjectDataArchiveInvariantError(
        'target_terminal_version_mismatch',
        'ProjectData archive target terminal version mismatch'
      );
    }
    return { idempotent: true, state };
  }

  const row: ProjectDataArchiveRow = { ...input.sessionRow };
  const placeholders = CHAT_SESSION_ANCHOR_COLUMNS.map(() => '?').join(', ');
  const insertSessionQuery = `INSERT INTO chat_sessions (${CHAT_SESSION_ANCHOR_COLUMNS.join(', ')})
     VALUES (${placeholders})`;
  sql.exec(insertSessionQuery, ...CHAT_SESSION_ANCHOR_COLUMNS.map((column) => row[column] ?? null));
  sql.exec(
    `INSERT INTO project_data_archive_target_sessions (
       session_id, project_id, migration_id, owner_name, generation, source_owner_name,
       source_intent_token, state, terminal_version_sha256, expected_message_count,
       received_message_count, created_at, updated_at
     )
     VALUES (?, ?, ?, ?, ?, ?, ?, 'prepared', ?, ?, 0, ?, ?)`,
    input.sessionId,
    input.projectId,
    input.migrationId,
    input.targetOwnerName,
    input.targetGeneration,
    input.sourceOwnerName,
    input.sourceIntentToken,
    input.terminalVersionSha256,
    input.expectedMessageCount,
    input.now,
    input.now
  );
  return { idempotent: false, state: 'prepared' };
}

function insertArchiveRow(
  sql: SqlStorage,
  tableName: ProjectDataArchiveTableName,
  row: Record<string, unknown>
): void {
  const spec = validateTableName(tableName);
  const existingQuery = `SELECT ${spec.columns.join(', ')} FROM ${tableName} WHERE ${spec.keyColumn} = ?`;
  const existing = sql.exec(existingQuery, row[spec.keyColumn]).toArray()[0];
  if (existing) {
    const expected = canonicalizeArchiveRow(spec.columns, row);
    const actual = canonicalizeArchiveRow(spec.columns, existing);
    if (expected !== actual) {
      throw new ProjectDataArchiveInvariantError(
        'target_row_conflict',
        'ProjectData archive target row conflicts with committed data'
      );
    }
    return;
  }
  const placeholders = spec.columns.map(() => '?').join(', ');
  const insertQuery = `INSERT INTO ${tableName} (${spec.columns.join(', ')})
     VALUES (${placeholders})`;
  sql.exec(insertQuery, ...spec.columns.map((column) => row[column] ?? null));
}

function readCommittedRowsForChunk(
  sql: SqlStorage,
  tableName: ProjectDataArchiveTableName,
  rowIds: readonly string[]
): ProjectDataArchiveRow[] {
  if (rowIds.length === 0) return [];
  const spec = validateTableName(tableName);
  // Cloudflare's SQL surfaces (D1 and Durable Object SqlStorage) reject the 101st bound
  // parameter, and this verification read binds one placeholder per chunk row. `rowIds` holds up
  // to PROJECT_DATA_ARCHIVE_CHUNK_ROWS entries (500 in production), so the read is sub-batched.
  // Sub-batching is safe for the hash because `rowIds` is built by exportArchiveRowsChunk as
  // rows.map(keyColumn) over `ORDER BY ${spec.orderBy}`, and every spec.orderBy ends in the
  // unique key column, making it a total order. Every id in one batch therefore sorts before
  // every id in the next, so concatenating batches in `rowIds` order reproduces the
  // single-statement result exactly. That ordering is load-bearing: callers re-hash these rows
  // with canonicalRowsSha256 against the source chunk hash. The order assertion below fails
  // closed if that precondition ever breaks, rather than surfacing as an opaque hash mismatch.
  //
  // Distinctness is asserted rather than assumed. `IN (...)` collapses repeats, so the single
  // statement read a duplicated id once and the length check below rejected the chunk. Split
  // across batches, an id repeated either side of a boundary is read once per batch, restoring
  // the count and hiding it. Every key column is a TEXT PRIMARY KEY so the exporter cannot emit
  // one -- which is exactly why sub-batching must not be allowed to quietly relax the check.
  if (new Set(rowIds).size !== rowIds.length) {
    throw new ProjectDataArchiveInvariantError(
      'target_chunk_duplicate_row_ids',
      'ProjectData archive target chunk row ids contain duplicates'
    );
  }
  const rows: ProjectDataArchiveRow[] = [];
  for (let offset = 0; offset < rowIds.length; offset += D1_MAX_BOUND_PARAMETERS) {
    const batch = rowIds.slice(offset, offset + D1_MAX_BOUND_PARAMETERS);
    const placeholders = batch.map(() => '?').join(', ');
    const query = `SELECT ${spec.columns.join(', ')} FROM ${tableName}
       WHERE ${spec.keyColumn} IN (${placeholders})
       ORDER BY ${spec.orderBy}`;
    for (const row of sql.exec(query, ...batch).toArray()) {
      rows.push(toArchiveRow(row, spec.columns));
    }
  }
  if (rows.length !== rowIds.length) {
    throw new ProjectDataArchiveInvariantError(
      'target_chunk_missing_rows',
      'ProjectData archive target chunk is missing committed rows'
    );
  }
  for (let index = 0; index < rowIds.length; index++) {
    if (rows[index]?.[spec.keyColumn] !== rowIds[index]) {
      throw new ProjectDataArchiveInvariantError(
        'target_chunk_row_order_mismatch',
        'ProjectData archive target chunk rows are not in source chunk order'
      );
    }
  }
  return rows;
}

export async function commitArchiveTargetChunk(
  sql: SqlStorage,
  input: ArchiveTargetCommitChunkInput
): Promise<ArchiveTargetCommitChunkResult> {
  const existingChunk = sql
    .exec(
      'SELECT sha256, row_count FROM project_data_archive_target_chunks WHERE chunk_id = ?',
      chunkId(input)
    )
    .toArray()[0];
  if (existingChunk) {
    if (existingChunk.sha256 !== input.sha256 || existingChunk.row_count !== input.rowCount) {
      throw new ProjectDataArchiveInvariantError(
        'target_chunk_conflict',
        'ProjectData archive target chunk conflicts with committed data'
      );
    }
    return {
      idempotent: true,
      tableName: input.tableName,
      rowCount: input.rowCount,
      sha256: input.sha256,
    };
  }
  const state = validateTargetOwner(readTargetSession(sql, input.sessionId), {
    projectId: input.projectId,
    sessionId: input.sessionId,
    migrationId: input.migrationId,
    targetOwnerName: input.targetOwnerName,
    targetGeneration: input.targetGeneration,
  });
  if (!['prepared', 'copying'].includes(state)) {
    throw new ProjectDataArchiveInvariantError(
      'target_not_copyable',
      'ProjectData archive target is not in a copyable state'
    );
  }
  const spec = validateTableName(input.tableName);
  const suppliedHash = await canonicalRowsSha256(spec.columns, input.rows);
  if (suppliedHash !== input.sha256) {
    throw new ProjectDataArchiveInvariantError(
      'source_chunk_hash_mismatch',
      'ProjectData archive source chunk hash did not match the supplied rows'
    );
  }
  for (const row of input.rows) {
    insertArchiveRow(sql, input.tableName, row);
  }
  const committedRows = readCommittedRowsForChunk(sql, input.tableName, input.rowIds);
  const committedHash = await canonicalRowsSha256(spec.columns, committedRows);
  if (committedHash !== input.sha256) {
    throw new ProjectDataArchiveInvariantError(
      'target_recomputed_hash_mismatch',
      'ProjectData archive target recompute did not match source chunk hash'
    );
  }
  sql.exec(
    `INSERT INTO project_data_archive_target_chunks (
       chunk_id, session_id, project_id, migration_id, owner_name, generation,
       table_name, ordinal, row_count, byte_count, sha256, committed_at
     )
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    chunkId(input),
    input.sessionId,
    input.projectId,
    input.migrationId,
    input.targetOwnerName,
    input.targetGeneration,
    input.tableName,
    input.ordinal,
    input.rowCount,
    input.byteCount,
    input.sha256,
    input.now
  );
  sql.exec(
    `UPDATE project_data_archive_target_sessions
     SET state = 'copying',
         received_message_count = (
           SELECT COUNT(*) FROM chat_messages WHERE session_id = ?
         ),
         updated_at = ?
     WHERE session_id = ?`,
    input.sessionId,
    input.now,
    input.sessionId
  );
  return {
    idempotent: false,
    tableName: input.tableName,
    rowCount: input.rowCount,
    sha256: input.sha256,
  };
}

function chunkId(
  input: Pick<ProjectDataArchiveChunk, 'migrationId' | 'tableName' | 'ordinal'>
): string {
  return `${input.migrationId}:${input.tableName}:${input.ordinal}`;
}

export async function sealArchiveTarget(
  sql: SqlStorage,
  input: ArchiveTargetSealInput
): Promise<ArchiveTargetSealResult> {
  const state = validateTargetOwner(readTargetSession(sql, input.sessionId), {
    projectId: input.projectId,
    sessionId: input.sessionId,
    migrationId: input.migrationId,
    targetOwnerName: input.targetOwnerName,
    targetGeneration: input.targetGeneration,
  });
  if (state === 'sealed' || state === 'published') {
    const row = readTargetSession(sql, input.sessionId);
    return {
      aggregateSha256: strictString(row?.aggregate_sha256, 'target.aggregate_sha256'),
      messageCount: countRows(
        sql,
        'SELECT COUNT(*) AS count FROM chat_messages WHERE session_id = ?',
        input.sessionId
      ),
      groupedCount: countRows(
        sql,
        'SELECT COUNT(*) AS count FROM chat_messages_grouped WHERE session_id = ?',
        input.sessionId
      ),
      toolArchiveCount: countRows(
        sql,
        'SELECT COUNT(*) AS count FROM tool_payload_archives WHERE session_id = ?',
        input.sessionId
      ),
    };
  }
  if (state !== 'copying' && state !== 'prepared') {
    throw new ProjectDataArchiveInvariantError(
      'target_not_sealable',
      'ProjectData archive target is not sealable'
    );
  }
  const hashPageRows = resolveHashPageRows(input.hashPageRows);
  const terminalVersion = await computeTerminalVersion(sql, input.sessionId, { hashPageRows });
  if (terminalVersion.sha256 !== input.terminalVersionSha256) {
    throw new ProjectDataArchiveInvariantError(
      'target_terminal_version_mismatch',
      'ProjectData archive target terminal version changed before seal'
    );
  }
  const chunkRows = sql
    .exec(
      `SELECT sha256 FROM project_data_archive_target_chunks
       WHERE session_id = ? AND migration_id = ?
       ORDER BY table_name ASC, ordinal ASC`,
      input.sessionId,
      input.migrationId
    )
    .toArray();
  const committedChunkHashes = chunkRows
    .map((row) => strictString(row.sha256, 'target_chunk.sha256'))
    .sort(compareArchiveStrings);
  if (
    JSON.stringify(committedChunkHashes) !==
    JSON.stringify([...input.expectedChunkHashes].sort(compareArchiveStrings))
  ) {
    throw new ProjectDataArchiveInvariantError(
      'target_chunk_inventory_mismatch',
      'ProjectData archive target chunk inventory does not match the coordinator expectation'
    );
  }
  rebuildTargetFts(sql, input.sessionId, hashPageRows);
  const aggregateSha256 = await sha256Hex(
    [
      `terminal:${input.terminalVersionSha256}`,
      `chunks:${committedChunkHashes.join(',')}`,
      `messages:${await tableAggregateSha256(sql, 'chat_messages', input.sessionId, hashPageRows)}`,
      `grouped:${await tableAggregateSha256(sql, 'chat_messages_grouped', input.sessionId, hashPageRows)}`,
      `tool_payload_archives:${await tableAggregateSha256(sql, 'tool_payload_archives', input.sessionId, hashPageRows)}`,
    ].join('\n')
  );
  const messageCount = countRows(
    sql,
    'SELECT COUNT(*) AS count FROM chat_messages WHERE session_id = ?',
    input.sessionId
  );
  const groupedCount = countRows(
    sql,
    'SELECT COUNT(*) AS count FROM chat_messages_grouped WHERE session_id = ?',
    input.sessionId
  );
  const toolArchiveCount = countRows(
    sql,
    'SELECT COUNT(*) AS count FROM tool_payload_archives WHERE session_id = ?',
    input.sessionId
  );
  sql.exec(
    `UPDATE project_data_archive_target_sessions
     SET state = 'sealed',
         aggregate_sha256 = ?,
         received_message_count = ?,
         sealed_at = ?,
         updated_at = ?
     WHERE session_id = ?`,
    aggregateSha256,
    messageCount,
    input.now,
    input.now,
    input.sessionId
  );
  return { aggregateSha256, messageCount, groupedCount, toolArchiveCount };
}

function readTargetChunkInventory(
  sql: SqlStorage,
  sessionId: string,
  migrationId: string | null
): ArchiveTargetInspectResult['chunks'] {
  const params: Array<string | number> = [sessionId];
  let whereClause = '';
  if (migrationId !== null) {
    whereClause = ' AND migration_id = ?';
    params.push(migrationId);
  }
  return sql
    .exec(
      `SELECT table_name, ordinal, sha256, row_count, byte_count
       FROM project_data_archive_target_chunks
       WHERE session_id = ?${whereClause}
       ORDER BY table_name ASC, ordinal ASC`,
      ...params
    )
    .toArray()
    .map((row) => {
      const tableName = row.table_name as ProjectDataArchiveTableName;
      validateTableName(tableName);
      return {
        tableName,
        ordinal: strictInteger(row.ordinal, 'target_chunk.ordinal'),
        sha256: strictString(row.sha256, 'target_chunk.sha256'),
        rowCount: strictInteger(row.row_count, 'target_chunk.row_count'),
        byteCount: strictInteger(row.byte_count, 'target_chunk.byte_count'),
      };
    });
}

export function inspectArchiveTargetSession(
  sql: SqlStorage,
  input: ArchiveTargetInspectInput
): ArchiveTargetInspectResult {
  const target = readTargetSession(sql, input.sessionId);
  const state = validateTargetOwner(target, input);
  return {
    state,
    terminalVersionSha256: strictString(
      target?.terminal_version_sha256,
      'target.terminal_version_sha256'
    ),
    aggregateSha256: optionalNonEmptyString(target?.aggregate_sha256),
    messageCount: countRows(
      sql,
      'SELECT COUNT(*) AS count FROM chat_messages WHERE session_id = ?',
      input.sessionId
    ),
    groupedCount: countRows(
      sql,
      'SELECT COUNT(*) AS count FROM chat_messages_grouped WHERE session_id = ?',
      input.sessionId
    ),
    toolArchiveCount: countRows(
      sql,
      'SELECT COUNT(*) AS count FROM tool_payload_archives WHERE session_id = ?',
      input.sessionId
    ),
    chunks: readTargetChunkInventory(sql, input.sessionId, input.migrationId),
    sessionRow: readSessionAnchor(sql, input.sessionId) ?? {},
    databaseSizeBytes: databaseSize(sql),
  };
}

async function exportArchiveRowsChunk(
  sql: SqlStorage,
  input: {
    migrationId: string;
    projectId: string;
    sessionId: string;
    sourceOwnerName: string;
    targetOwnerName: string;
    targetGeneration: number;
    tableName: ProjectDataArchiveTableName;
    ordinal: number;
    cursor?: string | null;
    maxRows?: number;
    maxBytes?: number;
  }
): Promise<ProjectDataArchiveChunk> {
  const spec = validateTableName(input.tableName);
  const maxBytes = normalizePositiveInteger(
    input.maxBytes,
    PROJECT_DATA_ARCHIVE_DEFAULT_CHUNK_BYTES,
    PROJECT_DATA_ARCHIVE_MAX_CHUNK_BYTES
  );
  const maxRows = normalizePositiveInteger(
    input.maxRows,
    PROJECT_DATA_ARCHIVE_DEFAULT_CHUNK_ROWS,
    PROJECT_DATA_ARCHIVE_DEFAULT_CHUNK_ROWS * 20
  );
  let query = `SELECT ${spec.columns.join(', ')} FROM ${input.tableName} WHERE session_id = ?`;
  const params: Array<string | number> = [input.sessionId];
  if (input.cursor) {
    query += ` AND ${spec.cursorPredicate}`;
    params.push(...spec.cursorValues(input.cursor));
  }
  query += ` ORDER BY ${spec.orderBy} LIMIT ?`;
  params.push(maxRows + 1);
  const candidates = sql.exec(query, ...params).toArray();
  const rows: ProjectDataArchiveRow[] = [];
  let byteCount = 0;
  for (const candidate of candidates.slice(0, maxRows)) {
    const row = toArchiveRow(candidate, spec.columns);
    const candidateBytes = byteLength(canonicalizeArchiveRow(spec.columns, row));
    if (candidateBytes > maxBytes) {
      throw new ProjectDataArchiveInvariantError(
        'archive_row_exceeds_chunk_budget',
        'ProjectData archive row exceeds the configured chunk byte budget'
      );
    }
    if (byteCount + candidateBytes > maxBytes) break;
    rows.push(row);
    byteCount += candidateBytes;
  }
  const hasMore = rows.length < candidates.length;
  const lastRow = rows.length > 0 ? rows[rows.length - 1] : null;
  const cursor = lastRow ? spec.cursorFromRow(lastRow) : (input.cursor ?? null);
  const rowIds = rows.map((row) =>
    strictString(row[spec.keyColumn], `${input.tableName}.${spec.keyColumn}`)
  );
  return {
    migrationId: input.migrationId,
    projectId: input.projectId,
    sessionId: input.sessionId,
    sourceOwnerName: input.sourceOwnerName,
    targetOwnerName: input.targetOwnerName,
    targetGeneration: input.targetGeneration,
    tableName: input.tableName,
    ordinal: input.ordinal,
    rows,
    rowIds,
    cursor,
    hasMore,
    rowCount: rows.length,
    byteCount,
    sha256: await canonicalRowsSha256(spec.columns, rows),
  };
}

export async function exportArchiveTargetChunk(
  sql: SqlStorage,
  input: ArchiveTargetExportChunkInput
): Promise<ProjectDataArchiveChunk> {
  const state = validateTargetOwner(readTargetSession(sql, input.sessionId), input);
  if (state !== 'sealed' && state !== 'published' && state !== 'rehome_exported') {
    throw new ProjectDataArchiveInvariantError(
      'target_not_exportable',
      'ProjectData archive target is not exportable for re-home or copy-back'
    );
  }
  return exportArchiveRowsChunk(sql, {
    migrationId: input.migrationId ?? `rehome:${input.sessionId}`,
    projectId: input.projectId,
    sessionId: input.sessionId,
    sourceOwnerName: input.targetOwnerName,
    targetOwnerName: input.targetOwnerName,
    targetGeneration: input.targetGeneration,
    tableName: input.tableName,
    ordinal: input.ordinal,
    cursor: input.cursor,
    maxRows: input.maxRows,
    maxBytes: input.maxBytes,
  });
}

function rebuildTargetFts(sql: SqlStorage, sessionId: string, pageRows: number): void {
  forEachGroupedRowPaged(sql, sessionId, pageRows, (row) => {
    try {
      sql.exec(
        'INSERT OR IGNORE INTO chat_messages_grouped_fts(rowid, content) VALUES (?, ?)',
        row.rowid,
        row.content
      );
    } catch (error) {
      log.warn('archive_target_fts_rebuild_row_failed', {
        sessionId,
        rowid: row.rowid,
        ...serializeError(error),
      });
    }
  });
}

export async function restoreSourceArchiveChunk(
  sql: SqlStorage,
  input: ArchiveSourceRestoreChunkInput
): Promise<ArchiveSourceRestoreChunkResult> {
  validateRootSourceOwner(input);
  const state = assertMatchingSourceIntent(readSourceIntent(sql, input.sessionId), input);
  if (state !== 'source_deleted' && state !== 'rehome_exported') {
    throw new ProjectDataArchiveInvariantError(
      'source_not_copy_back_restoreable',
      'ProjectData archive source can only be restored after source deletion proof exists'
    );
  }
  const spec = validateTableName(input.tableName);
  const suppliedHash = await canonicalRowsSha256(spec.columns, input.rows);
  if (suppliedHash !== input.sha256) {
    throw new ProjectDataArchiveInvariantError(
      'copy_back_chunk_hash_mismatch',
      'ProjectData archive copy-back chunk hash did not match supplied rows'
    );
  }
  let inserted = 0;
  for (const row of input.rows) {
    const before = countRows(
      sql,
      `SELECT COUNT(*) AS count FROM ${input.tableName} WHERE ${spec.keyColumn} = ?`,
      strictString(row[spec.keyColumn], `${input.tableName}.${spec.keyColumn}`)
    );
    insertArchiveRow(sql, input.tableName, row);
    const after = countRows(
      sql,
      `SELECT COUNT(*) AS count FROM ${input.tableName} WHERE ${spec.keyColumn} = ?`,
      strictString(row[spec.keyColumn], `${input.tableName}.${spec.keyColumn}`)
    );
    if (after > before) inserted++;
  }
  const committedRows = readCommittedRowsForChunk(sql, input.tableName, input.rowIds);
  const committedHash = await canonicalRowsSha256(spec.columns, committedRows);
  if (committedHash !== input.sha256) {
    throw new ProjectDataArchiveInvariantError(
      'copy_back_committed_hash_mismatch',
      'ProjectData archive copy-back committed rows do not match source chunk hash'
    );
  }
  return {
    tableName: input.tableName,
    rowCount: input.rowCount,
    sha256: input.sha256,
    idempotent: inserted === 0,
  };
}

export async function markSourceCopyBackRestored(
  sql: SqlStorage,
  input: {
    projectId: string;
    sessionId: string;
    migrationId: string;
    sourceOwnerName: string;
    targetOwnerName: string;
    targetGeneration: number;
    sourceIntentToken: string;
    expectedTerminalVersionSha256: string;
    now: number;
    hashPageRows?: number;
  }
): Promise<boolean> {
  validateRootSourceOwner(input);
  const state = assertMatchingSourceIntent(readSourceIntent(sql, input.sessionId), input);
  if (state !== 'source_deleted' && state !== 'rehome_exported') {
    throw new ProjectDataArchiveInvariantError(
      'source_not_copy_back_restored',
      'ProjectData archive source copy-back cannot be marked before source deletion proof'
    );
  }
  const hashPageRows = resolveHashPageRows(input.hashPageRows);
  rebuildTargetFts(sql, input.sessionId, hashPageRows);
  const terminalVersion = await computeTerminalVersion(sql, input.sessionId, { hashPageRows });
  if (terminalVersion.sha256 !== input.expectedTerminalVersionSha256) {
    throw new ProjectDataArchiveInvariantError(
      'copy_back_terminal_version_mismatch',
      'ProjectData archive copy-back did not restore the terminal version'
    );
  }
  const result = sql.exec(
    `UPDATE project_data_archive_source_intents
     SET state = 'rehome_exported',
         updated_at = ?
     WHERE session_id = ?
       AND project_id = ?
       AND migration_id = ?
       AND source_intent_token = ?
       AND state IN ('source_deleted', 'rehome_exported')`,
    input.now,
    input.sessionId,
    input.projectId,
    input.migrationId,
    input.sourceIntentToken
  );
  sql.exec(
    `UPDATE chat_sessions
     SET archive_state = 'copy_back_restored',
         updated_at = updated_at
     WHERE id = ?`,
    input.sessionId
  );
  return (result.rowsWritten ?? 0) > 0;
}

export function markArchiveTargetRehomeExported(
  sql: SqlStorage,
  input: {
    projectId: string;
    sessionId: string;
    migrationId: string | null;
    targetOwnerName: string;
    targetGeneration: number;
    now: number;
  }
): boolean {
  const state = validateTargetOwner(readTargetSession(sql, input.sessionId), input);
  if (state !== 'sealed' && state !== 'published' && state !== 'rehome_exported') {
    throw new ProjectDataArchiveInvariantError(
      'target_not_rehome_exported',
      'ProjectData archive target cannot be marked re-home exported before seal'
    );
  }
  const result = sql.exec(
    `UPDATE project_data_archive_target_sessions
     SET state = 'rehome_exported',
         updated_at = ?
     WHERE session_id = ?
       AND project_id = ?
       AND owner_name = ?
       AND generation = ?
       AND state IN ('sealed', 'published', 'rehome_exported')`,
    input.now,
    input.sessionId,
    input.projectId,
    input.targetOwnerName,
    input.targetGeneration
  );
  return (result.rowsWritten ?? 0) > 0;
}

export type ArchiveSourceAbandonIntentInput = {
  projectId: string;
  sessionId: string;
  migrationId: string;
  sourceOwnerName: string;
  targetOwnerName: string;
  targetGeneration: number;
  now: number;
};

export type ArchiveSourceAbandonIntentResult = {
  /** True when an intent row for this migration existed and was removed. */
  removed: boolean;
  /** The intent state observed before removal, or null when no intent existed. */
  state: ProjectDataArchiveSourceIntentState | null;
  databaseSizeBytes: number;
};

/**
 * Abandon a migration on the root source BEFORE any source deletion proof exists.
 *
 * The only source-side record a pre-copy migration leaves behind is its
 * `project_data_archive_source_intents` row (`finalizeSourceDelete` is the sole writer of
 * `chat_sessions.archive_*`), so abandoning is deleting that row. Refuses once the source
 * transcript has been deleted or re-homed: those migrations need copy-back, not abandon.
 * Idempotent: a missing intent returns `removed: false` so the coordinator can finish the
 * D1 side of an interrupted abandon.
 */
export function abandonArchiveSourceIntent(
  sql: SqlStorage,
  input: ArchiveSourceAbandonIntentInput
): ArchiveSourceAbandonIntentResult {
  validateRootSourceOwner(input);
  const intent = readSourceIntent(sql, input.sessionId);
  if (!intent) return { removed: false, state: null, databaseSizeBytes: databaseSize(sql) };
  const state = assertSameSourceIntentMigration(intent, input);
  if (state === 'source_deleted' || state === 'rehome_exported') {
    throw new ProjectDataArchiveInvariantError(
      'abandon_requires_source_intact',
      'ProjectData archive abandon refuses a migration whose source payload was already deleted; use copy-back'
    );
  }
  const result = sql.exec(
    `DELETE FROM project_data_archive_source_intents
     WHERE session_id = ? AND project_id = ? AND migration_id = ?`,
    input.sessionId,
    input.projectId,
    input.migrationId
  );
  return {
    removed: (result.rowsWritten ?? 0) > 0,
    state,
    databaseSizeBytes: databaseSize(sql),
  };
}

export type ArchiveTargetAbandonInput = {
  projectId: string;
  sessionId: string;
  migrationId: string;
  targetOwnerName: string;
  targetGeneration: number;
  now: number;
  /**
   * A `sealed` target may be the only surviving copy: the source is deleted AFTER seal and
   * the target never transitions past `sealed` inside this object. The shard cannot see
   * the root object, so the coordinator must inspect the source intent first and assert
   * it is still intact before a sealed target may be dropped.
   *
   * This is a caller assertion, not evidence the shard can re-derive. The only sanctioned
   * caller is `abandonProjectDataArchiveMigration` (scheduled/project-data-archive-sharding.ts),
   * which sets it immediately after `inspectSourceIntent` on the root object. Any new caller
   * must perform that inspection itself; never pass `true` from a request body.
   */
  sourceIntactVerified?: boolean;
  /** See `ArchiveSourcePrepareInput.hashPageRows`: DO-owned page size, never set by coordinators. */
  hashPageRows?: number;
};

export type ArchiveTargetAbandonResult = {
  /** True when a target session for this migration existed and was removed. */
  removed: boolean;
  /** Target state observed before removal, or null when no target session existed. */
  state: ProjectDataArchiveTargetState | null;
  messagesDeleted: number;
  groupedRowsDeleted: number;
  ftsRowsDeleted: number;
  toolArchiveRowsDeleted: number;
  chunksDeleted: number;
  databaseSizeBytes: number;
};

/**
 * Remove a partially copied session from an archive shard so the migration can be
 * abandoned and the root session unfenced.
 *
 * Every delete is scoped to `session_id`: the shard holds other sessions. Refuses once the
 * target is `published` or `rehome_exported`, because by then the source transcript is gone
 * and this copy is the only one. Grouped rows are visited in bounded pages so a large
 * partial copy cannot reproduce the memory reset this operation exists to recover from.
 */
export function abandonArchiveTargetSession(
  sql: SqlStorage,
  input: ArchiveTargetAbandonInput
): ArchiveTargetAbandonResult {
  const target = readTargetSession(sql, input.sessionId);
  if (!target) {
    return {
      removed: false,
      state: null,
      messagesDeleted: 0,
      groupedRowsDeleted: 0,
      ftsRowsDeleted: 0,
      toolArchiveRowsDeleted: 0,
      chunksDeleted: 0,
      databaseSizeBytes: databaseSize(sql),
    };
  }
  const state = validateTargetOwner(target, input);
  // `published` is refused for completeness, but no shard writer sets it today: publishing
  // only touches the D1 location, so a fully published session still reads `sealed` here.
  // The effective guard for "this may be the only copy" is therefore the `sealed` branch
  // below, and the coordinator's source-first ordering that backs `sourceIntactVerified`.
  if (state === 'published' || state === 'rehome_exported') {
    throw new ProjectDataArchiveInvariantError(
      'target_not_abandonable',
      'ProjectData archive target holds the only copy of a published session; abandon refused'
    );
  }
  if (state === 'sealed' && input.sourceIntactVerified !== true) {
    throw new ProjectDataArchiveInvariantError(
      'target_sealed_requires_source_proof',
      'ProjectData archive sealed target may be the only copy; verify the source intent is intact before abandoning'
    );
  }
  const pageRows = resolveHashPageRows(input.hashPageRows);
  let ftsRowsDeleted = 0;
  let groupedRowsDeleted = 0;
  forEachGroupedRowPaged(sql, input.sessionId, pageRows, (row) => {
    try {
      sql.exec(
        `INSERT INTO chat_messages_grouped_fts(chat_messages_grouped_fts, rowid, content)
         VALUES('delete', ?, ?)`,
        row.rowid,
        row.content
      );
      ftsRowsDeleted++;
    } catch (error) {
      log.warn('archive_target_abandon_fts_delete_marker_failed', {
        sessionId: input.sessionId,
        rowid: row.rowid,
        ...serializeError(error),
      });
    }
    const deleteGrouped = sql.exec('DELETE FROM chat_messages_grouped WHERE rowid = ?', row.rowid);
    groupedRowsDeleted += deleteGrouped.rowsWritten ?? 0;
  });
  const toolArchiveRowsDeleted =
    sql.exec('DELETE FROM tool_payload_archives WHERE session_id = ?', input.sessionId)
      .rowsWritten ?? 0;
  const messagesDeleted =
    sql.exec('DELETE FROM chat_messages WHERE session_id = ?', input.sessionId).rowsWritten ?? 0;
  const chunksDeleted =
    sql.exec(
      'DELETE FROM project_data_archive_target_chunks WHERE session_id = ? AND migration_id = ?',
      input.sessionId,
      input.migrationId
    ).rowsWritten ?? 0;
  sql.exec(
    `DELETE FROM project_data_archive_target_sessions
     WHERE session_id = ? AND project_id = ? AND migration_id = ? AND owner_name = ? AND generation = ?`,
    input.sessionId,
    input.projectId,
    input.migrationId,
    input.targetOwnerName,
    input.targetGeneration
  );
  sql.exec('DELETE FROM chat_sessions WHERE id = ?', input.sessionId);
  return {
    removed: true,
    state,
    messagesDeleted,
    groupedRowsDeleted,
    ftsRowsDeleted,
    toolArchiveRowsDeleted,
    chunksDeleted,
    databaseSizeBytes: databaseSize(sql),
  };
}

export async function finalizeSourceDelete(
  sql: SqlStorage,
  input: ArchiveSourceFinalizeDeleteInput
): Promise<ArchiveSourceFinalizeDeleteResult> {
  validateRootSourceOwner(input);
  const state = assertMatchingSourceIntent(readSourceIntent(sql, input.sessionId), input);
  if (state === 'source_deleted') {
    const intent = readSourceIntent(sql, input.sessionId);
    return {
      idempotent: true,
      lastMessageAt:
        typeof intent?.last_message_at === 'number' && Number.isSafeInteger(intent.last_message_at)
          ? intent.last_message_at
          : null,
      messagesDeleted: 0,
      groupedRowsDeleted: 0,
      ftsRowsDeleted: 0,
      toolArchiveRowsDeleted: 0,
      databaseSizeBeforeBytes:
        typeof intent?.source_database_size_before === 'number'
          ? intent.source_database_size_before
          : 0,
      databaseSizeAfterBytes:
        typeof intent?.source_database_size_after === 'number'
          ? intent.source_database_size_after
          : 0,
    };
  }
  if (state !== 'recovery_manifest_persisted') {
    throw new ProjectDataArchiveInvariantError(
      'source_not_finalizable',
      'ProjectData archive source delete requires persisted recovery manifest proof'
    );
  }
  assertEligibleTerminalSource(
    sql,
    input.sessionId,
    input.now,
    input.minTerminalAgeMs ?? PROJECT_DATA_ARCHIVE_DEFAULT_SESSION_GRACE_MS
  );
  const hashPageRows = resolveHashPageRows(input.hashPageRows);
  const terminalVersion = await computeTerminalVersion(sql, input.sessionId, { hashPageRows });
  if (terminalVersion.sha256 !== input.expectedTerminalVersionSha256) {
    throw new ProjectDataArchiveInvariantError(
      'terminal_version_changed',
      'ProjectData archive terminal version changed before source delete'
    );
  }

  const databaseSizeBeforeBytes = databaseSize(sql);
  let ftsRowsDeleted = 0;
  let groupedRowsDeleted = 0;
  forEachGroupedRowPaged(sql, input.sessionId, hashPageRows, (row) => {
    try {
      sql.exec(
        `INSERT INTO chat_messages_grouped_fts(chat_messages_grouped_fts, rowid, content)
         VALUES('delete', ?, ?)`,
        row.rowid,
        row.content
      );
      ftsRowsDeleted++;
    } catch (error) {
      log.warn('archive_source_fts_delete_marker_failed', {
        sessionId: input.sessionId,
        rowid: row.rowid,
        ...serializeError(error),
      });
    }
    const deleteGrouped = sql.exec('DELETE FROM chat_messages_grouped WHERE rowid = ?', row.rowid);
    groupedRowsDeleted += deleteGrouped.rowsWritten ?? 0;
  });
  const toolArchiveRowsDeleted =
    sql.exec('DELETE FROM tool_payload_archives WHERE session_id = ?', input.sessionId)
      .rowsWritten ?? 0;
  const messagesDeleted =
    sql.exec('DELETE FROM chat_messages WHERE session_id = ?', input.sessionId).rowsWritten ?? 0;
  sql.exec(
    `UPDATE chat_sessions
     SET archive_last_message_at = ?,
         archive_owner_name = ?,
         archive_generation = ?,
         archive_migration_id = ?,
         archive_state = 'source_deleted',
         updated_at = updated_at
     WHERE id = ?`,
    terminalVersion.lastMessageAt,
    input.targetOwnerName,
    input.targetGeneration,
    input.migrationId,
    input.sessionId
  );
  const databaseSizeAfterBytes = databaseSize(sql);
  sql.exec(
    `UPDATE project_data_archive_source_intents
     SET state = 'source_deleted',
         target_aggregate_sha256 = ?,
         recovery_manifest_key = ?,
         source_deleted_at = ?,
         source_database_size_before = ?,
         source_database_size_after = ?,
         updated_at = ?
     WHERE session_id = ? AND migration_id = ? AND source_intent_token = ?`,
    input.targetAggregateSha256,
    input.r2ManifestKey,
    input.now,
    databaseSizeBeforeBytes,
    databaseSizeAfterBytes,
    input.now,
    input.sessionId,
    input.migrationId,
    input.sourceIntentToken
  );
  return {
    idempotent: false,
    lastMessageAt: terminalVersion.lastMessageAt,
    messagesDeleted,
    groupedRowsDeleted,
    ftsRowsDeleted,
    toolArchiveRowsDeleted,
    databaseSizeBeforeBytes,
    databaseSizeAfterBytes,
  };
}

export function markSourceRecoveryManifestPersisted(
  sql: SqlStorage,
  input: {
    sessionId: string;
    migrationId: string;
    sourceIntentToken: string;
    targetAggregateSha256: string;
    r2ManifestKey: string;
    now: number;
  }
): boolean {
  const intent = readSourceIntent(sql, input.sessionId);
  if (
    !intent ||
    intent.migration_id !== input.migrationId ||
    intent.source_intent_token !== input.sourceIntentToken
  ) {
    throw new ProjectDataArchiveInvariantError(
      'source_intent_mismatch',
      'ProjectData archive source intent token mismatch'
    );
  }
  const state = validateIntentState(intent.state);
  if (
    (state === 'recovery_manifest_persisted' || state === 'source_deleted') &&
    intent?.target_aggregate_sha256 === input.targetAggregateSha256 &&
    intent?.recovery_manifest_key === input.r2ManifestKey
  ) {
    return true;
  }
  const result = sql.exec(
    `UPDATE project_data_archive_source_intents
     SET state = 'recovery_manifest_persisted',
         target_aggregate_sha256 = ?,
         recovery_manifest_key = ?,
         recovery_manifest_persisted_at = ?,
         updated_at = ?
     WHERE session_id = ?
       AND migration_id = ?
       AND source_intent_token = ?
       AND state = 'target_sealed'`,
    input.targetAggregateSha256,
    input.r2ManifestKey,
    input.now,
    input.now,
    input.sessionId,
    input.migrationId,
    input.sourceIntentToken
  );
  return (result.rowsWritten ?? 0) > 0;
}

export function markSourceTargetSealed(
  sql: SqlStorage,
  input: {
    sessionId: string;
    migrationId: string;
    sourceIntentToken: string;
    targetAggregateSha256: string;
    now: number;
  }
): boolean {
  const intent = readSourceIntent(sql, input.sessionId);
  if (
    !intent ||
    intent.migration_id !== input.migrationId ||
    intent.source_intent_token !== input.sourceIntentToken
  ) {
    throw new ProjectDataArchiveInvariantError(
      'source_intent_mismatch',
      'ProjectData archive source intent token mismatch'
    );
  }
  const state = validateIntentState(intent.state);
  if (
    ['target_sealed', 'recovery_manifest_persisted', 'source_deleted'].includes(state) &&
    intent?.target_aggregate_sha256 === input.targetAggregateSha256
  ) {
    return true;
  }
  const result = sql.exec(
    `UPDATE project_data_archive_source_intents
     SET state = 'target_sealed',
         target_aggregate_sha256 = ?,
         target_sealed_at = ?,
         updated_at = ?
     WHERE session_id = ?
       AND migration_id = ?
       AND source_intent_token = ?
       AND state IN ('intent_prepared', 'target_prepared', 'copying')`,
    input.targetAggregateSha256,
    input.now,
    input.now,
    input.sessionId,
    input.migrationId,
    input.sourceIntentToken
  );
  return (result.rowsWritten ?? 0) > 0;
}

export function archiveSourceReadMessages(
  sql: SqlStorage,
  env: Env,
  input: ProjectDataArchiveExactReadInput,
  limit: number,
  before: number | null,
  after: number | null,
  roles: string[] | undefined,
  compact: boolean,
  order: 'asc' | 'desc'
): { messages: Record<string, unknown>[]; hasMore: boolean } {
  validateRootSourceOwner({
    projectId: input.projectId,
    sourceOwnerName: input.ownerName,
    targetOwnerName: `${input.ownerName}:not-target`,
    targetGeneration: 1,
  });
  const source = readSourceIntent(sql, input.sessionId);
  if (source && isActiveSourceIntentState(validateIntentState(source.state))) {
    throw new ProjectDataArchiveInvariantError(
      'source_migration_in_progress',
      'ProjectData archive source exact read failed closed because the source has an archive migration intent'
    );
  }
  const compactOptions = compact ? messages.resolveCompactMessageOptions(env) : undefined;
  return messages.getMessages(
    sql,
    input.sessionId,
    limit,
    before,
    after,
    roles,
    compact,
    order,
    compactOptions
  );
}

export function archiveSourceReadMessageCount(
  sql: SqlStorage,
  input: ProjectDataArchiveExactReadInput,
  roles?: string[]
): number {
  validateRootSourceOwner({
    projectId: input.projectId,
    sourceOwnerName: input.ownerName,
    targetOwnerName: `${input.ownerName}:not-target`,
    targetGeneration: 1,
  });
  const source = readSourceIntent(sql, input.sessionId);
  if (source && isActiveSourceIntentState(validateIntentState(source.state))) {
    throw new ProjectDataArchiveInvariantError(
      'source_migration_in_progress',
      'ProjectData archive source count read failed closed because the source has an archive migration intent'
    );
  }
  return messages.getMessageCount(sql, input.sessionId, roles);
}

function assertSourceExactReadAvailable(
  sql: SqlStorage,
  input: ProjectDataArchiveExactReadInput,
  operation: string
): void {
  validateRootSourceOwner({
    projectId: input.projectId,
    sourceOwnerName: input.ownerName,
    targetOwnerName: `${input.ownerName}:not-target`,
    targetGeneration: 1,
  });
  const source = readSourceIntent(sql, input.sessionId);
  if (source && isActiveSourceIntentState(validateIntentState(source.state))) {
    throw new ProjectDataArchiveInvariantError(
      'source_migration_in_progress',
      `ProjectData archive source ${operation} failed closed because the source has an archive migration intent`
    );
  }
}

export async function archiveSourceReadMessageToolContent(
  sql: SqlStorage,
  env: Env,
  input: ProjectDataArchiveExactReadInput & { messageId: string }
): Promise<MessageToolContentResult | null> {
  assertSourceExactReadAvailable(sql, input, 'tool-content read');
  const inlineContent = messages.getMessageToolContent(sql, input.sessionId, input.messageId);
  if (inlineContent === null) return null;
  if (inlineContent.length > 0) return { content: inlineContent, source: 'inline' };
  return (
    (await toolPayloadArchive.readArchivedMessageToolContent(
      sql,
      env,
      input.projectId,
      input.sessionId,
      input.messageId
    )) ?? { content: inlineContent, source: 'inline' }
  );
}

export async function archiveSourceReadArchivedToolPayloads(
  sql: SqlStorage,
  env: Env,
  projectId: string,
  input: toolPayloadArchive.ArchivedToolPayloadQuery,
  owner: ProjectDataArchiveExactReadInput
): Promise<ArchivedToolPayloadListResult> {
  assertSourceExactReadAvailable(sql, owner, 'archived-payload read');
  return toolPayloadArchive.listArchivedToolPayloads(sql, env, projectId, input);
}

export function archiveSourceSearchMessages(
  sql: SqlStorage,
  input: ProjectDataArchiveExactReadInput,
  query: string,
  roles: string[] | null,
  limit: number
) {
  assertSourceExactReadAvailable(sql, input, 'search read');
  return messages.searchMessages(sql, query, input.sessionId, roles, limit);
}

export function archiveTargetReadMessages(
  sql: SqlStorage,
  env: Env,
  input: ProjectDataArchiveExactReadInput,
  limit: number,
  before: number | null,
  after: number | null,
  roles: string[] | undefined,
  compact: boolean,
  order: 'asc' | 'desc'
): { messages: Record<string, unknown>[]; hasMore: boolean } {
  validateTargetOwner(readTargetSession(sql, input.sessionId), {
    projectId: input.projectId,
    sessionId: input.sessionId,
    migrationId: input.migrationId,
    targetOwnerName: input.ownerName,
    targetGeneration: input.generation,
  });
  const state = validateTargetOwner(readTargetSession(sql, input.sessionId), {
    projectId: input.projectId,
    sessionId: input.sessionId,
    migrationId: input.migrationId,
    targetOwnerName: input.ownerName,
    targetGeneration: input.generation,
  });
  if (state !== 'sealed' && state !== 'published') {
    throw new ProjectDataArchiveInvariantError(
      'target_not_published',
      'ProjectData archive target exact read is not sealed'
    );
  }
  const compactOptions = compact ? messages.resolveCompactMessageOptions(env) : undefined;
  return messages.getMessages(
    sql,
    input.sessionId,
    limit,
    before,
    after,
    roles,
    compact,
    order,
    compactOptions
  );
}

export async function archiveTargetReadMessageToolContent(
  sql: SqlStorage,
  env: Env,
  input: ProjectDataArchiveExactReadInput & { messageId: string }
): Promise<MessageToolContentResult | null> {
  const state = validateTargetOwner(readTargetSession(sql, input.sessionId), {
    projectId: input.projectId,
    sessionId: input.sessionId,
    migrationId: input.migrationId,
    targetOwnerName: input.ownerName,
    targetGeneration: input.generation,
  });
  if (state !== 'sealed' && state !== 'published') {
    throw new ProjectDataArchiveInvariantError(
      'target_not_published',
      'ProjectData archive target tool-content read is not sealed'
    );
  }
  const inlineContent = messages.getMessageToolContent(sql, input.sessionId, input.messageId);
  if (inlineContent === null) return null;
  if (inlineContent.length > 0) return { content: inlineContent, source: 'inline' };
  return (
    (await toolPayloadArchive.readArchivedMessageToolContent(
      sql,
      env,
      input.projectId,
      input.sessionId,
      input.messageId
    )) ?? { content: inlineContent, source: 'inline' }
  );
}

export function archiveTargetReadMessageCount(
  sql: SqlStorage,
  input: ProjectDataArchiveExactReadInput,
  roles?: string[]
): number {
  const state = validateTargetOwner(readTargetSession(sql, input.sessionId), {
    projectId: input.projectId,
    sessionId: input.sessionId,
    migrationId: input.migrationId,
    targetOwnerName: input.ownerName,
    targetGeneration: input.generation,
  });
  if (state !== 'sealed' && state !== 'published') {
    throw new ProjectDataArchiveInvariantError(
      'target_not_published',
      'ProjectData archive target count read is not sealed'
    );
  }
  return messages.getMessageCount(sql, input.sessionId, roles);
}

export async function archiveTargetReadArchivedToolPayloads(
  sql: SqlStorage,
  env: Env,
  projectId: string,
  input: toolPayloadArchive.ArchivedToolPayloadQuery,
  owner: ProjectDataArchiveExactReadInput
): Promise<ArchivedToolPayloadListResult> {
  const state = validateTargetOwner(readTargetSession(sql, owner.sessionId), {
    projectId: owner.projectId,
    sessionId: owner.sessionId,
    migrationId: owner.migrationId,
    targetOwnerName: owner.ownerName,
    targetGeneration: owner.generation,
  });
  if (state !== 'sealed' && state !== 'published') {
    throw new ProjectDataArchiveInvariantError(
      'target_not_published',
      'ProjectData archive target archived-payload read is not sealed'
    );
  }
  return toolPayloadArchive.listArchivedToolPayloads(sql, env, projectId, input);
}

export function archiveTargetSearchMessages(
  sql: SqlStorage,
  input: ProjectDataArchiveExactReadInput,
  query: string,
  roles: string[] | null,
  limit: number
) {
  const state = validateTargetOwner(readTargetSession(sql, input.sessionId), {
    projectId: input.projectId,
    sessionId: input.sessionId,
    migrationId: input.migrationId,
    targetOwnerName: input.ownerName,
    targetGeneration: input.generation,
  });
  if (state !== 'sealed' && state !== 'published') {
    throw new ProjectDataArchiveInvariantError(
      'target_not_published',
      'ProjectData archive target search read is not sealed'
    );
  }
  return messages.searchMessages(sql, query, input.sessionId, roles, limit);
}

export function archiveTargetSearchProjectMessages(
  sql: SqlStorage,
  input: ProjectDataArchiveOwnerRef,
  query: string,
  roles: string[] | null,
  limit: number
): ArchiveSearchResult[] {
  if (input.kind !== 'archive_shard' || input.generation <= 0) {
    throw new ProjectDataArchiveInvariantError(
      'target_owner_mismatch',
      'ProjectData archive project search must target an archive shard owner'
    );
  }
  const results: ArchiveSearchResult[] = [];
  const ftsQuery = messages.buildFtsQuery(query);
  if (ftsQuery) {
    const conditions = [
      'f.chat_messages_grouped_fts MATCH ?',
      't.project_id = ?',
      't.owner_name = ?',
      't.generation = ?',
      "t.state IN ('sealed', 'published')",
    ];
    const params: Array<string | number> = [
      ftsQuery,
      input.projectId,
      input.ownerName,
      input.generation,
    ];
    if (roles && roles.length > 0) {
      const placeholders = roles.map(() => '?').join(', ');
      conditions.push(`m.role IN (${placeholders})`);
      params.push(...roles);
    }
    const whereClause = conditions.join(' AND ');
    try {
      const rows = sql
        .exec(
          `SELECT m.id, m.session_id, m.role, m.content, m.created_at,
                  s.topic AS session_topic, s.task_id AS session_task_id
           FROM chat_messages_grouped_fts f
           JOIN chat_messages_grouped m ON m.rowid = f.rowid
           JOIN chat_sessions s ON s.id = m.session_id
           JOIN project_data_archive_target_sessions t ON t.session_id = m.session_id
           WHERE ${whereClause}
           ORDER BY rank
           LIMIT ?`,
          ...params,
          limit
        )
        .toArray();
      results.push(...rows.map((row) => mapArchiveSearchRow(row, query)));
    } catch (error) {
      log.error('archive_sharding.target_project_fts_search_failed', {
        ownerName: input.ownerName,
        generation: input.generation,
        error: String(error),
      });
    }
  }

  if (results.length < limit) {
    const escapedQuery = query.replace(/[%_\\]/g, '\\$&');
    const conditions = [
      "m.content LIKE ? ESCAPE '\\'",
      "COALESCE(m.origin, 'user') != 'system'",
      't.project_id = ?',
      't.owner_name = ?',
      't.generation = ?',
      "t.state IN ('sealed', 'published')",
    ];
    const params: Array<string | number> = [
      `%${escapedQuery}%`,
      input.projectId,
      input.ownerName,
      input.generation,
    ];
    if (roles && roles.length > 0) {
      const placeholders = roles.map(() => '?').join(', ');
      conditions.push(`m.role IN (${placeholders})`);
      params.push(...roles);
    }
    const whereClause = conditions.join(' AND ');
    const seen = new Set(results.map((result) => result.id));
    const rows = sql
      .exec(
        `SELECT m.id, m.session_id, m.role, m.content, m.created_at,
                s.topic AS session_topic, s.task_id AS session_task_id
         FROM chat_messages m
         JOIN chat_sessions s ON s.id = m.session_id
         JOIN project_data_archive_target_sessions t ON t.session_id = m.session_id
         WHERE ${whereClause}
         ORDER BY m.created_at DESC
         LIMIT ?`,
        ...params,
        limit
      )
      .toArray();
    for (const row of rows) {
      const mapped = mapArchiveSearchRow(row, query);
      if (!seen.has(mapped.id)) {
        results.push(mapped);
        seen.add(mapped.id);
      }
      if (results.length >= limit) break;
    }
  }

  return results.sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
}
