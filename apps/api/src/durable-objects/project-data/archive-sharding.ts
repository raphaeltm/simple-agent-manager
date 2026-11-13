// FILE SIZE EXCEPTION: ProjectData terminal archive migration state machine — keeping source intent, target copy/seal, canonical hash, exact-read guards, and final source-delete invariants in one module avoids cross-file transaction coupling during Fable review. See .claude/rules/18-file-size-limits.md
import type { MessageCursor } from '@simple-agent-manager/shared';

import { D1_MAX_BOUND_PARAMETERS } from '../../lib/d1-limits';
import { createModuleLogger, serializeError } from '../../lib/logger';
import {
  COMPACT_ARCHIVE_FORMAT,
  compactArchiveTimeout,
  type CompactChunkRef,
  LEGACY_ARCHIVE_FORMAT,
} from '../../project-data-archive/compact-r2';
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
  type ProjectDataArchiveSourcePrepareRefusal,
  type ProjectDataArchiveTableName,
  type ProjectDataArchiveTargetState,
} from '../../project-data-archive/contract';
import {
  byteLength,
  canonicalizeArchiveRow,
  canonicalRowsSha256,
  compareArchiveStrings,
  createCanonicalRowsChainHasher,
  createCanonicalRowsHasher,
  sha256Hex,
} from '../../project-data-archive/hashing';
import {
  type ArchiveWriteReservation,
  estimateArchiveWrites,
} from '../../project-data-archive/write-budget';
import { isDurableObjectSqliteNoMemError } from '../../services/durable-object-retry';
import {
  MESSAGE_COMMENT_REPLY_COUNT_SQL,
  MESSAGE_COMMENT_THREAD_COUNT_SQL,
} from './anchored-comment-scope';
import * as compactArchive from './compact-archive';
import { resolveMaterializationPassConfig } from './materialization';
import * as messages from './messages';
import type {
  ArchivedToolPayloadListResult,
  MessageToolContentResult,
} from './tool-payload-archive';
import * as toolPayloadArchive from './tool-payload-archive';
import type { Env } from './types';

const log = createModuleLogger('project_data.archive_sharding');
const PENDING_TERMINAL_VERSION_SHA256 = 'pending';
// Slice A keeps repair deliberately incremental without exposing the project-wide
// search tuning surface. Slice B owns configurable archive-search concurrency.
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
  'materialized_through_created_at',
  'materialized_through_sequence',
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
  writeReservation?: ArchiveWriteReservation;
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

/**
 * What the root object's prepare RPC returns: the prepared source proof, or a typed refusal
 * when a pre-copy eligibility invariant rejected the session before anything was written.
 */
export type ArchiveSourcePrepareOutcome =
  ArchiveSourcePrepareResult | ProjectDataArchiveSourcePrepareRefusal;

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
      /** Recorded by prepares since migration 076; null for intents prepared before it. */
      terminalComponents?: ArchiveTerminalComponents | null;
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
  storageFormat?: typeof COMPACT_ARCHIVE_FORMAT | typeof LEGACY_ARCHIVE_FORMAT;
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
  rawChunkRef?: CompactChunkRef;
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
  /**
   * Skip the whole-session R2 re-read an already sealed compact target performs. Set only by
   * coordinators that verify the R2 chunks in bounded pages (`archiveTargetVerifyPage`) before
   * the flip; an older coordinator omits it and keeps the one-RPC recompute it relies on.
   */
  skipCompactRecoveryRecompute?: boolean;
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

/**
 * The flip deletes no rows, so the `*Deleted` counts are always 0 and the sizes are equal on a
 * fresh flip. They are kept so the RPC shape and the `sourceFinalization` log stay compatible
 * across a mixed-version deploy; reclaim reports the real counts.
 */
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
  storageFormat: string;
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
    sourceCursor: string | null;
    sourceHasMore: boolean | null;
    r2Key?: string;
    rawChunkRef?: CompactChunkRef;
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
  components: ArchiveTerminalComponents;
};

/**
 * The parts of a terminal version, recorded by the root at prepare. The shard recomputes the
 * parts it holds in its own SQLite (anchor, grouped rows, tool-payload archives) before the flip
 * and compares them here, because the paged R2 check covers only the message rows.
 */
export type ArchiveTerminalComponents = {
  anchorSha256: string;
  messagesSha256: string;
  groupedSha256: string;
  toolPayloadArchivesSha256: string;
  commentThreads: number;
  commentReplies: number;
};

type CompactRawEvidence = {
  sha256: string;
  messageCount: number;
  lastMessageAt: number | null;
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
export const GROUPED_ROW_PAGE_SQL = `SELECT rowid, id, role, content, created_at FROM chat_messages_grouped
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
  // `activity = 'error'` is deliberately not a refusal: `failSession` writes it as the terminal
  // mirror of a failed session, so on a session that has been terminal for the whole grace it
  // describes no live writer. Live work is still refused by prompting/recovering, an active or
  // settling runtime, and the active ACP check above. Counting 'error' froze 125 production
  // sessions (2026-11-12) that nothing could ever unfreeze.
  if (
    countRows(
      sql,
      `SELECT COUNT(*) AS count
       FROM session_state ss
       LEFT JOIN acp_sessions acp ON acp.id = ss.session_id
       WHERE (ss.session_id = ? OR acp.chat_session_id = ?)
         AND (
           ss.activity IN ('prompting', 'recovering')
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
  // An unresolved marker blocks archiving until the session grace has passed since its last
  // deadline: its expiry for an expiring marker, its creation for a non-expiring one
  // (`idle_cleanup_failed`, `wake_failed`). Neither kind is resolved when the session stops or
  // fails, so the old unconditional check froze 35 production sessions (2026-11-12) behind
  // markers nothing would ever resolve. Measuring from the expiry, not "is it expired", keeps a
  // marker the expiry alarm has not processed yet from racing an archive (the alarm can still
  // call `failSession`). Markers stay in the root object either way; archiving does not move them.
  if (
    countRows(
      sql,
      `SELECT COUNT(*) AS count FROM session_attention_markers
       WHERE session_id = ?
         AND resolved_at IS NULL
         AND COALESCE(expires_at, created_at) > ?`,
      sessionId,
      now - minTerminalAgeMs
    ) > 0
  ) {
    throw new ProjectDataArchiveInvariantError(
      'unresolved_attention',
      'ProjectData archive refuses sessions with unresolved attention markers'
    );
  }
  // Message comments cascade-delete with their messages, so a session that has any is refused.
  if (
    countRows(sql, MESSAGE_COMMENT_THREAD_COUNT_SQL, sessionId) > 0 ||
    countRows(sql, MESSAGE_COMMENT_REPLY_COUNT_SQL, sessionId) > 0
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
  pageRows: number,
  yieldBetweenPages?: () => Promise<void>
): Promise<string> {
  const spec = validateTableName(tableName);
  const hasher = createCanonicalRowsHasher(spec.columns);
  let cursor: string | null = null;
  for (let page = 0; ; page++) {
    if (page > 0 && yieldBetweenPages) await yieldBetweenPages();
    let query = `SELECT ${spec.columns.join(', ')} FROM ${tableName} WHERE session_id = ?`;
    const params: Array<string | number> = [sessionId];
    if (cursor) {
      query += ` AND ${spec.cursorPredicate}`;
      params.push(...spec.cursorValues(cursor));
    }
    query += ` ORDER BY ${spec.orderBy} LIMIT ?`;
    params.push(pageRows);
    let count = 0;
    let tail: Record<string, unknown> | null = null;
    for (const raw of sql.exec(query, ...params)) {
      hasher.update(toArchiveRow(raw, spec.columns));
      tail = raw;
      count++;
    }
    if (count < pageRows || !tail) break;
    cursor = spec.cursorFromRow(tail);
  }
  return hasher.digestHex();
}

export type ComputeTerminalVersionOptions = {
  hashPageRows?: number;
  /**
   * Awaited between hash pages so the object can serve other requests while a large session
   * is hashed. Only safe where something else proves the rows did not change between pages
   * (the archive write generation, `prepareArchiveSourceIntentPhased`).
   */
  yieldBetweenPages?: () => Promise<void>;
  compactEnv?: Env;
  compactDeadline?: number;
  compactPerChunkTimeoutMs?: number;
  compactRawEvidence?: CompactRawEvidence;
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
  const raw =
    options.compactRawEvidence ??
    (options.compactEnv && compactArchive.isCompactArchive(sql, sessionId)
      ? await compactArchive.compactRawDigest(
          sql,
          options.compactEnv,
          sessionId,
          options.compactPerChunkTimeoutMs ?? options.compactDeadline,
          options.compactPerChunkTimeoutMs ? { perChunk: true } : undefined
        )
      : null);
  const messageCount =
    raw?.messageCount ??
    countRows(sql, 'SELECT COUNT(*) AS count FROM chat_messages WHERE session_id = ?', sessionId);
  const lastMessageAt = raw ? raw.lastMessageAt : readLastMessageAt(sql, sessionId);
  const yieldBetweenPages = options.yieldBetweenPages;
  const anchor = canonicalizeArchiveRow(CHAT_SESSION_ANCHOR_COLUMNS, sessionRow);
  const messagesSha256 =
    raw?.sha256 ??
    (await tableAggregateSha256(sql, 'chat_messages', sessionId, pageRows, yieldBetweenPages));
  if (yieldBetweenPages) await yieldBetweenPages();
  const groupedSha256 = await tableAggregateSha256(
    sql,
    'chat_messages_grouped',
    sessionId,
    pageRows,
    yieldBetweenPages
  );
  if (yieldBetweenPages) await yieldBetweenPages();
  const toolPayloadArchivesSha256 = await tableAggregateSha256(
    sql,
    'tool_payload_archives',
    sessionId,
    pageRows,
    yieldBetweenPages
  );
  const commentThreads = countRows(sql, MESSAGE_COMMENT_THREAD_COUNT_SQL, sessionId);
  const commentReplies = countRows(sql, MESSAGE_COMMENT_REPLY_COUNT_SQL, sessionId);
  const components = [
    `chat_session:${anchor}`,
    `chat_messages:${messagesSha256}`,
    `chat_messages_grouped:${groupedSha256}`,
    `tool_payload_archives:${toolPayloadArchivesSha256}`,
    `comments:${commentThreads}:${commentReplies}`,
    `last_message_at:${lastMessageAt ?? 'null'}`,
  ];
  return {
    sha256: await sha256Hex(components.join('\n')),
    lastMessageAt,
    messageCount,
    sessionRow,
    components: {
      anchorSha256: await sha256Hex(anchor),
      messagesSha256,
      groupedSha256,
      toolPayloadArchivesSha256,
      commentThreads,
      commentReplies,
    },
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

/**
 * Whether the root's copy of a session can no longer answer exact reads.
 *
 * Deliberately narrower than the transcript write fence (`assertTranscriptWriteAllowed` in
 * `messages.ts`, every intent state but `rehome_exported`), which must stay closed for the whole
 * migration (rule 67: widening a shared predicate would reopen writes). Before the flip the
 * root still holds every row of the session and writes to it are fenced, so its copy is
 * complete and immutable: a migration that spans many ticks keeps the transcript readable from
 * the root until the atomic flip. From `source_deleted` on, routing points at the shard and
 * the root's rows are leftovers awaiting reclaim, or rows a copy-back is restoring, so reads
 * fail closed there.
 */
function isSourceExactReadFenced(state: ProjectDataArchiveSourceIntentState): boolean {
  return state === 'source_deleted';
}

function reattachSourceIntentToken(
  sql: SqlStorage,
  input: Pick<
    ArchiveSourcePrepareInput,
    'sourceIntentToken' | 'now' | 'sessionId' | 'projectId' | 'migrationId'
  >,
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
  if (isCompletedCopyBackPredecessor(sql, intent, input)) {
    return { exists: false, databaseSizeBytes: databaseSize(sql) };
  }
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
    terminalComponents: parseTerminalComponents(intent.terminal_components_json),
  };
}

function parseTerminalComponents(value: unknown): ArchiveTerminalComponents | null {
  if (typeof value !== 'string') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const record = parsed as Record<string, unknown>;
  const text = (key: string) => (typeof record[key] === 'string' ? (record[key] as string) : null);
  const count = (key: string) =>
    Number.isSafeInteger(record[key]) && (record[key] as number) >= 0
      ? (record[key] as number)
      : null;
  const anchorSha256 = text('anchorSha256');
  const messagesSha256 = text('messagesSha256');
  const groupedSha256 = text('groupedSha256');
  const toolPayloadArchivesSha256 = text('toolPayloadArchivesSha256');
  const commentThreads = count('commentThreads');
  const commentReplies = count('commentReplies');
  if (
    anchorSha256 === null ||
    messagesSha256 === null ||
    groupedSha256 === null ||
    toolPayloadArchivesSha256 === null ||
    commentThreads === null ||
    commentReplies === null
  ) {
    return null;
  }
  return {
    anchorSha256,
    messagesSha256,
    groupedSha256,
    toolPayloadArchivesSha256,
    commentThreads,
    commentReplies,
  };
}

/** A verified copy-back releases the root for a strictly newer migration. Old RPCs
 * still have to match the current intent, so they cannot mutate the successor. */
function isCompletedCopyBackPredecessor(
  sql: SqlStorage,
  intent: Record<string, unknown> | null,
  input: ArchiveSourceInspectIntentInput
): boolean {
  if (
    intent?.state !== 'rehome_exported' ||
    intent.session_id !== input.sessionId ||
    intent.project_id !== input.projectId ||
    intent.source_owner_name !== input.sourceOwnerName ||
    intent.migration_id === input.migrationId ||
    typeof intent.target_generation !== 'number' ||
    !Number.isSafeInteger(input.targetGeneration) ||
    !Number.isSafeInteger(intent.target_generation) ||
    intent.target_generation >= input.targetGeneration
  )
    return false;
  const anchor = sql
    .exec<{
      archive_state: string | null;
      archive_migration_id: string | null;
      archive_generation: number | null;
      archive_owner_name: string | null;
    }>(
      `SELECT archive_state, archive_migration_id, archive_generation, archive_owner_name
     FROM chat_sessions WHERE id = ?`,
      input.sessionId
    )
    .toArray()[0];
  return (
    anchor?.archive_state === 'copy_back_restored' &&
    anchor.archive_migration_id === intent.migration_id &&
    anchor.archive_generation === intent.target_generation &&
    anchor.archive_owner_name === intent.target_owner_name
  );
}

function assertPreparedSourceIntent(
  existing: Record<string, unknown>,
  input: ArchiveSourcePrepareInput,
  terminalVersionSha256: string
): ProjectDataArchiveSourceIntentState {
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
    existing.terminal_version_sha256 !== terminalVersionSha256
  ) {
    throw new ProjectDataArchiveInvariantError(
      'terminal_version_changed',
      'ProjectData archive terminal version changed after source intent'
    );
  }
  return state;
}

/**
 * Prepare the source intent, or return a typed refusal when a pre-copy eligibility invariant
 * rejects the session before any write. This is the `archiveSourcePrepareIntent` RPC body.
 *
 * The D1 candidate query cannot see the DO-local eligibility guards (`session_state`, ACP
 * rows, comments, attention markers, ...), so the coordinator fences a session `migrating` and
 * only then learns here that it cannot move. A refusal is returned ONLY while no source intent
 * row exists for the session, or only a verified completed copy-back predecessor remains.
 * Every later invariant (including the same eligibility check on a
 * re-prepare with an intent present, and at finalize) still throws, because by then the
 * transcript is fenced on this object and the coordinator must keep the journal on its
 * fail-closed retry path. Returning instead of throwing is what lets the refusal cross the RPC
 * boundary with its `reason` intact (rule 63) so the caller can unwind the fence.
 */
export async function prepareArchiveSourceIntentOrRefuse(
  sql: SqlStorage,
  input: ArchiveSourcePrepareInput
): Promise<ArchiveSourcePrepareOutcome> {
  const begun = beginArchiveSourcePrepare(sql, input, {
    estimateExceedsReservation: estimateExceedsReservation(sql, input),
  });
  if (begun.kind === 'refused') return begun.refusal;
  const terminalVersion = await computeTerminalVersion(sql, input.sessionId, {
    hashPageRows: input.hashPageRows,
  });
  return completeArchiveSourcePrepare(sql, input, begun, terminalVersion);
}

/** Whether the session's inventory now exceeds what its write reservation was sized for. */
export function estimateExceedsReservation(
  sql: SqlStorage,
  input: Pick<ArchiveSourcePrepareInput, 'sessionId' | 'writeReservation'>
): boolean {
  return (
    !!input.writeReservation &&
    estimateArchiveWrites(
      sql,
      input.sessionId,
      input.writeReservation.factor,
      input.writeReservation.maxMessages
    ) > input.writeReservation.estimatedWrites
  );
}

/** Current archive write generation of a session (migration 076); 0 before any counted write. */
export function readArchiveWriteGeneration(sql: SqlStorage, sessionId: string): number {
  const row = sql
    .exec(
      'SELECT generation FROM project_data_archive_source_write_generation WHERE session_id = ?',
      sessionId
    )
    .toArray()[0];
  return Number(row?.generation ?? 0);
}

export type ArchiveSourcePrepareBegun =
  | { kind: 'refused'; refusal: Extract<ArchiveSourcePrepareOutcome, { refused: true }> }
  | { kind: 'proceed'; existing: Record<string, unknown> | null; generation: number };

/**
 * First phase of the source prepare, run under the transcript lock: eligibility, then the
 * source intent (the transcript write fence), then the write generation the hash must still
 * see when it finishes.
 *
 * A refusal is returned ONLY while no source intent row exists for the session, or only a
 * verified completed copy-back predecessor remains. Every later invariant (including the same
 * eligibility check on a re-prepare with an intent present, and at finalize) still throws,
 * because by then the transcript is fenced on this object and the coordinator must keep the
 * journal on its fail-closed retry path. Returning instead of throwing is what lets the refusal
 * cross the RPC boundary with its `reason` intact (rule 63) so the caller can unwind the fence.
 */
export function beginArchiveSourcePrepare(
  sql: SqlStorage,
  input: ArchiveSourcePrepareInput,
  options: { estimateExceedsReservation: boolean }
): ArchiveSourcePrepareBegun {
  validateRootSourceOwner(input);
  const minTerminalAgeMs = input.minTerminalAgeMs ?? PROJECT_DATA_ARCHIVE_DEFAULT_SESSION_GRACE_MS;
  let existing = readSourceIntent(sql, input.sessionId);
  const completedPredecessor = isCompletedCopyBackPredecessor(sql, existing, input);
  try {
    assertEligibleTerminalSource(sql, input.sessionId, input.now, minTerminalAgeMs);
    if (options.estimateExceedsReservation) {
      throw new ProjectDataArchiveInvariantError(
        'write_budget_inventory_changed',
        'Archive inventory exceeds its reserved write estimate'
      );
    }
  } catch (error) {
    if ((!existing || completedPredecessor) && error instanceof ProjectDataArchiveInvariantError) {
      return {
        kind: 'refused',
        refusal: {
          refused: true,
          reason: error.reason,
          message: error.message,
          databaseSizeBytes: databaseSize(sql),
        },
      };
    }
    throw error;
  }
  if (completedPredecessor && existing) {
    // No await between replacement and the fresh fence below; the caller holds the source
    // mutation lock. This removes only the completed intent, never history.
    sql.exec(
      `DELETE FROM project_data_archive_source_intents
       WHERE session_id = ? AND migration_id = ? AND state = 'rehome_exported'`,
      input.sessionId,
      existing.migration_id as string
    );
    existing = null;
  }
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
  // Read after the intent exists: from here every write to the session's hashed rows moves it.
  return {
    kind: 'proceed',
    existing,
    generation: readArchiveWriteGeneration(sql, input.sessionId),
  };
}

/**
 * Last phase of the source prepare, run under the transcript lock after the hash. The hash may
 * have run in pages with other requests served in between; the unchanged write generation is
 * what proves those pages saw one consistent session. Records the terminal version, its
 * components and the generation the flip will compare against.
 */
export function completeArchiveSourcePrepare(
  sql: SqlStorage,
  input: ArchiveSourcePrepareInput,
  begun: { existing: Record<string, unknown> | null; generation: number },
  terminalVersion: TerminalVersion
): ArchiveSourcePrepareResult & { databaseSizeBytes: number } {
  if (readArchiveWriteGeneration(sql, input.sessionId) !== begun.generation) {
    throw new ProjectDataArchiveInvariantError(
      'terminal_version_changed',
      'ProjectData archive source changed while its terminal version was being hashed'
    );
  }
  const current = readSourceIntent(sql, input.sessionId);
  const state = assertSameSourceIntentMigration(current, input);
  if (!begun.existing && current?.source_intent_token !== input.sourceIntentToken) {
    throw new ProjectDataArchiveInvariantError(
      'source_intent_mismatch',
      'ProjectData archive source intent was replaced while it was being hashed'
    );
  }
  const componentsJson = JSON.stringify(terminalVersion.components);
  if (begun.existing) {
    const preparedState = assertPreparedSourceIntent(
      current as Record<string, unknown>,
      input,
      terminalVersion.sha256
    );
    if (current?.source_intent_token !== input.sourceIntentToken) {
      reattachSourceIntentToken(sql, input, preparedState);
    }
  } else if (state !== 'intent_prepared') {
    throw new ProjectDataArchiveInvariantError(
      'source_intent_mismatch',
      'ProjectData archive source intent advanced while it was being hashed'
    );
  }
  sql.exec(
    `UPDATE project_data_archive_source_intents
     SET terminal_version_sha256 = ?,
         last_message_at = ?,
         message_count = ?,
         prepared_write_generation = ?,
         terminal_components_json = ?,
         updated_at = ?
     WHERE session_id = ?
       AND project_id = ?
       AND migration_id = ?
       AND state = ?`,
    terminalVersion.sha256,
    terminalVersion.lastMessageAt,
    terminalVersion.messageCount,
    begun.generation,
    componentsJson,
    input.now,
    input.sessionId,
    input.projectId,
    input.migrationId,
    state
  );
  return {
    idempotent: begun.existing !== null,
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
  if (
    input.storageFormat !== undefined &&
    input.storageFormat !== LEGACY_ARCHIVE_FORMAT &&
    input.storageFormat !== COMPACT_ARCHIVE_FORMAT
  ) {
    throw new Error('Unsupported archive storage format');
  }
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
       received_message_count, created_at, updated_at, storage_format
     )
     VALUES (?, ?, ?, ?, ?, ?, ?, 'prepared', ?, ?, 0, ?, ?, ?)`,
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
    input.now,
    input.storageFormat ?? LEGACY_ARCHIVE_FORMAT
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
  input: ArchiveTargetCommitChunkInput,
  env?: Env,
  transactionSync: <T>(callback: () => T) => T = (callback) => callback()
): Promise<ArchiveTargetCommitChunkResult> {
  const state = validateTargetOwner(readTargetSession(sql, input.sessionId), {
    projectId: input.projectId,
    sessionId: input.sessionId,
    migrationId: input.migrationId,
    targetOwnerName: input.targetOwnerName,
    targetGeneration: input.targetGeneration,
  });
  const spec = validateTableName(input.tableName);
  const existingChunk = sql
    .exec(
      `SELECT sha256, row_count, source_cursor, source_has_more
       FROM project_data_archive_target_chunks WHERE chunk_id = ?`,
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
    const legacyReceipt =
      existingChunk.source_cursor === null && existingChunk.source_has_more === null;
    if (legacyReceipt) {
      const replayHash = await canonicalRowsSha256(spec.columns, input.rows);
      if (replayHash !== input.sha256) {
        throw new ProjectDataArchiveInvariantError(
          'source_chunk_hash_mismatch',
          'ProjectData archive source replay did not match the legacy target receipt'
        );
      }
      transactionSync(() => {
        sql.exec(
          `UPDATE project_data_archive_target_chunks
           SET source_cursor = ?, source_has_more = ?
           WHERE chunk_id = ? AND source_cursor IS NULL AND source_has_more IS NULL`,
          input.cursor,
          input.hasMore ? 1 : 0,
          chunkId(input)
        );
        // Receipts created before durable projection checkpoints are replayed
        // by the coordinator. Reuse those authenticated source rows to adopt
        // the receipt and projection progress atomically without re-reading R2.
        if (compactArchive.isCompactArchive(sql, input.sessionId) && env) {
          commitCompactSearchProjectionChunk(sql, env, input, input.rows);
        }
      });
    } else if (
      existingChunk.source_cursor !== input.cursor ||
      Boolean(existingChunk.source_has_more) !== input.hasMore
    ) {
      throw new ProjectDataArchiveInvariantError(
        'target_chunk_continuation_conflict',
        'ProjectData archive target chunk continuation conflicts with committed data'
      );
    }
    return {
      idempotent: true,
      tableName: input.tableName,
      rowCount: input.rowCount,
      sha256: input.sha256,
    };
  }
  if (!['prepared', 'copying'].includes(state)) {
    throw new ProjectDataArchiveInvariantError(
      'target_not_copyable',
      'ProjectData archive target is not in a copyable state'
    );
  }
  const suppliedHash = await canonicalRowsSha256(spec.columns, input.rows);
  if (suppliedHash !== input.sha256) {
    throw new ProjectDataArchiveInvariantError(
      'source_chunk_hash_mismatch',
      'ProjectData archive source chunk hash did not match the supplied rows'
    );
  }
  const compact = compactArchive.isCompactArchive(sql, input.sessionId);
  const rawCompact = input.tableName === 'chat_messages' && compact;
  let committedHash: string;
  let verifiedCompact: Awaited<ReturnType<typeof compactArchive.verifyCompactRawChunk>> | null =
    null;
  if (rawCompact) {
    if (!env || !input.rawChunkRef)
      throw new Error('Compact archive requires a verified R2 reference');
    verifiedCompact = await compactArchive.verifyCompactRawChunk(env, input, input.rawChunkRef);
    committedHash = input.sha256;
  } else {
    for (const row of input.rows) insertArchiveRow(sql, input.tableName, row);
    committedHash = await canonicalRowsSha256(
      spec.columns,
      readCommittedRowsForChunk(sql, input.tableName, input.rowIds)
    );
  }
  if (committedHash !== input.sha256) {
    throw new ProjectDataArchiveInvariantError(
      'target_recomputed_hash_mismatch',
      'ProjectData archive target recompute did not match source chunk hash'
    );
  }
  transactionSync(() => {
    if (rawCompact) {
      if (!input.rawChunkRef || !verifiedCompact || !env) {
        throw new Error('Compact archive verified chunk state is missing');
      }
      compactArchive.commitVerifiedCompactRawChunk(sql, input, input.rawChunkRef, verifiedCompact);
    }
    if (compact && env) {
      commitCompactSearchProjectionChunk(
        sql,
        env,
        input,
        rawCompact && verifiedCompact ? verifiedCompact.rows : input.rows
      );
    }
    sql.exec(
      `INSERT INTO project_data_archive_target_chunks (
       chunk_id, session_id, project_id, migration_id, owner_name, generation,
       table_name, ordinal, row_count, byte_count, sha256, committed_at
       , source_cursor, source_has_more
     )
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      input.now,
      input.cursor,
      input.hasMore ? 1 : 0
    );
    sql.exec(
      `UPDATE project_data_archive_target_sessions
     SET state = 'copying',
         received_message_count = ?,
         updated_at = ?
     WHERE session_id = ?`,
      compactArchive.isCompactArchive(sql, input.sessionId)
        ? compactArchive.compactMessageCount(sql, input.sessionId)
        : countRows(
            sql,
            'SELECT COUNT(*) AS count FROM chat_messages WHERE session_id = ?',
            input.sessionId
          ),
      input.now,
      input.sessionId
    );
  });
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

async function readValidatedSeal(
  sql: SqlStorage,
  input: ArchiveTargetSealInput,
  env: Env | undefined,
  compactPerChunkTimeoutMs: number
): Promise<ArchiveTargetSealResult> {
  const row = readTargetSession(sql, input.sessionId);
  // A resumed coordinator must not delete the root copy using a historical seal
  // if an external R2 loss occurred while the migration was paused. Coordinators that verify
  // R2 page by page before the flip skip this whole-session read (`verifyArchiveTargetPage`).
  if (
    env &&
    !input.skipCompactRecoveryRecompute &&
    compactArchive.isCompactArchive(sql, input.sessionId)
  ) {
    const verified = await computeTerminalVersion(sql, input.sessionId, {
      compactEnv: env,
      compactPerChunkTimeoutMs,
      hashPageRows: input.hashPageRows,
    });
    if (
      verified.sha256 !== input.terminalVersionSha256 ||
      verified.sha256 !== row?.terminal_version_sha256
    ) {
      throw new ProjectDataArchiveInvariantError(
        'target_terminal_version_mismatch',
        'Compact archive recovery proof no longer matches'
      );
    }
  }
  await ensureArchiveSearchCoverage(sql, env, input.sessionId, input.now);
  return {
    aggregateSha256: strictString(row?.aggregate_sha256, 'target.aggregate_sha256'),
    messageCount: compactArchive.isCompactArchive(sql, input.sessionId)
      ? compactArchive.compactMessageCount(sql, input.sessionId)
      : countRows(
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

export async function sealArchiveTarget(
  sql: SqlStorage,
  input: ArchiveTargetSealInput,
  env?: Env
): Promise<ArchiveTargetSealResult> {
  const compactPerChunkTimeoutMs = compactArchiveTimeout(env?.PROJECT_DATA_ARCHIVE_R2_TIMEOUT_MS);
  const state = validateTargetOwner(readTargetSession(sql, input.sessionId), {
    projectId: input.projectId,
    sessionId: input.sessionId,
    migrationId: input.migrationId,
    targetOwnerName: input.targetOwnerName,
    targetGeneration: input.targetGeneration,
  });
  if (compactArchive.isCompactArchive(sql, input.sessionId) && !env)
    throw new Error('Compact archive environment required');
  if (state === 'sealed' || state === 'published') {
    return readValidatedSeal(sql, input, env, compactPerChunkTimeoutMs);
  }
  if (state !== 'copying' && state !== 'prepared') {
    throw new ProjectDataArchiveInvariantError(
      'target_not_sealable',
      'ProjectData archive target is not sealable'
    );
  }
  const hashPageRows = resolveHashPageRows(input.hashPageRows);
  const compact = compactArchive.isCompactArchive(sql, input.sessionId);
  const rebuiltCoverage = compact
    ? readArchiveSearchCoverage(sql, input.sessionId)
    : await rebuildArchiveSearchProjection(sql, env, input.sessionId, input.now);
  if (compact && !rebuiltCoverage) {
    throw new ProjectDataArchiveInvariantError(
      'archive_search_index_incomplete',
      'Compact archive projection was not completed by the verified copy'
    );
  }
  const target = readTargetSession(sql, input.sessionId);
  if (target?.terminal_version_sha256 !== input.terminalVersionSha256) {
    throw new ProjectDataArchiveInvariantError(
      'target_terminal_version_mismatch',
      'ProjectData archive target terminal version changed before seal'
    );
  }
  const chunkRows = sql
    .exec(
      `SELECT table_name, ordinal, sha256, row_count
       FROM project_data_archive_target_chunks
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
  if (!compact) rebuildTargetFts(sql, input.sessionId, hashPageRows);
  if (!compact && rebuiltCoverage) {
    verifyArchiveSearchProjection(sql, input.sessionId, rebuiltCoverage, hashPageRows);
  }
  const compactMessageCount = compact
    ? compactArchive.compactMessageCount(sql, input.sessionId)
    : 0;
  if (
    compact &&
    compactMessageCount !==
      strictInteger(target?.expected_message_count, 'target.expected_message_count')
  ) {
    throw new ProjectDataArchiveInvariantError(
      'target_message_count_mismatch',
      'Compact archive target message count does not match the prepared source count'
    );
  }
  const compactTableDigest = async (tableName: ProjectDataArchiveTableName) =>
    sha256Hex(
      chunkRows
        .filter((row) => row.table_name === tableName)
        .map(
          (row) =>
            `${strictInteger(row.ordinal, 'target_chunk.ordinal')}:${strictString(row.sha256, 'target_chunk.sha256')}:${strictInteger(row.row_count, 'target_chunk.row_count')}`
        )
        .join('\n')
    );
  const aggregateSha256 = await sha256Hex(
    [
      `terminal:${input.terminalVersionSha256}`,
      `chunks:${committedChunkHashes.join(',')}`,
      `messages:${
        compact
          ? await compactTableDigest('chat_messages')
          : await tableAggregateSha256(sql, 'chat_messages', input.sessionId, hashPageRows)
      }`,
      `grouped:${
        compact
          ? await compactTableDigest('chat_messages_grouped')
          : await tableAggregateSha256(sql, 'chat_messages_grouped', input.sessionId, hashPageRows)
      }`,
      `tool_payload_archives:${
        compact
          ? await compactTableDigest('tool_payload_archives')
          : await tableAggregateSha256(sql, 'tool_payload_archives', input.sessionId, hashPageRows)
      }`,
    ].join('\n')
  );
  const messageCount = compact
    ? compactMessageCount
    : countRows(
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

export type ArchiveTargetVerifyPageInput = {
  projectId: string;
  sessionId: string;
  migrationId: string;
  targetOwnerName: string;
  targetGeneration: number;
  terminalVersionSha256: string;
  /**
   * The root's terminal-version components recorded at prepare. The final page compares the
   * shard's own anchor, grouped and tool-payload rows against them; the R2 pages cover messages.
   */
  expectedComponents: ArchiveTerminalComponents;
  /** Epoch ms after which this call starts no new chunk read. At least one chunk is read. */
  deadlineAt: number;
  now: number;
};

export type ArchiveTargetVerifyPageResult = {
  complete: boolean;
  /** Chunks read and checked by this call. */
  chunksVerified: number;
  /** Rows checked by this call. */
  rowsVerified: number;
  /** Next raw chunk ordinal to verify; equals the chunk count once complete. */
  nextOrdinal: number;
  /** Rows verified so far across every call for this migration. */
  totalRowsVerified: number;
  /**
   * Set when the copy did not verify: a missing or unreadable R2 object, a hash, order, identity
   * or count mismatch. Returned rather than thrown so the reason crosses the RPC boundary
   * (rule 63); the coordinator fails the migration and the root keeps every row.
   */
  failure?: { reason: string; message: string };
};

/**
 * Progress of a paged compact verification, kept in the shard's `do_meta` (no table migration)
 * while the verification is in flight and removed once it completes or the target is abandoned.
 */
const VERIFY_PROGRESS_META_PREFIX = 'archive_target_verify:';

type VerifyProgress = {
  migrationId: string;
  terminalVersionSha256: string;
  nextOrdinal: number;
  rows: number;
  /** Order key of the last verified row: [created_at, sequence, id]. */
  lastKey: [number, number | null, string] | null;
  /**
   * Set once every check passed. Kept (not deleted) so a claim that fails AFTER verification,
   * e.g. at the flip, does not re-read the whole copy and count that as progress: a re-run returns
   * `complete` with zero chunks verified, so the poison counter still advances.
   */
  complete?: boolean;
  /** Set when a check failed for good; later calls return it without re-reading anything. */
  failure?: { reason: string; message: string };
};

function readVerifyProgress(
  sql: SqlStorage,
  sessionId: string,
  migrationId: string,
  terminalVersionSha256: string
): VerifyProgress {
  const fresh: VerifyProgress = {
    migrationId,
    terminalVersionSha256,
    nextOrdinal: 0,
    rows: 0,
    lastKey: null,
  };
  const value = sql
    .exec('SELECT value FROM do_meta WHERE key = ?', VERIFY_PROGRESS_META_PREFIX + sessionId)
    .toArray()[0]?.value;
  if (typeof value !== 'string') return fresh;
  try {
    const parsed: unknown = JSON.parse(value);
    if (isVerifyProgress(parsed, migrationId, terminalVersionSha256)) return parsed;
  } catch {
    // An unreadable progress row only costs a restart from ordinal 0.
  }
  return fresh;
}

function isVerifyProgress(
  value: unknown,
  migrationId: string,
  terminalVersionSha256: string
): value is VerifyProgress {
  if (!value || typeof value !== 'object') return false;
  const progress = value as Record<string, unknown>;
  const lastKey = progress.lastKey;
  const lastKeyValid =
    lastKey === null ||
    (Array.isArray(lastKey) &&
      lastKey.length === 3 &&
      typeof lastKey[0] === 'number' &&
      (lastKey[1] === null || typeof lastKey[1] === 'number') &&
      typeof lastKey[2] === 'string');
  return (
    progress.migrationId === migrationId &&
    progress.terminalVersionSha256 === terminalVersionSha256 &&
    Number.isSafeInteger(progress.nextOrdinal) &&
    (progress.nextOrdinal as number) >= 0 &&
    Number.isSafeInteger(progress.rows) &&
    (progress.rows as number) >= 0 &&
    lastKeyValid &&
    (progress.complete === undefined || typeof progress.complete === 'boolean') &&
    (progress.failure === undefined ||
      (typeof progress.failure === 'object' &&
        progress.failure !== null &&
        typeof (progress.failure as Record<string, unknown>).reason === 'string' &&
        typeof (progress.failure as Record<string, unknown>).message === 'string'))
  );
}

function messageOrderKey(row: ProjectDataArchiveRow): [number, number | null, string] {
  const createdAt = Number(row.created_at);
  const sequence =
    row.sequence === null || row.sequence === undefined ? null : Number(row.sequence);
  return [createdAt, sequence, String(row.id)];
}

/** SQLite order of `created_at ASC, sequence ASC, id ASC` (NULL sorts first). */
function compareMessageOrderKeys(
  left: [number, number | null, string],
  right: [number, number | null, string]
): number {
  if (left[0] !== right[0]) return left[0] < right[0] ? -1 : 1;
  if (left[1] !== right[1]) {
    if (left[1] === null) return -1;
    if (right[1] === null) return 1;
    return left[1] < right[1] ? -1 : 1;
  }
  return compareUtf8Bytes(left[2], right[2]);
}

const utf8Encoder = new TextEncoder();

/** SQLite BINARY collation order: UTF-8 bytes, not JS UTF-16 code units. */
function compareUtf8Bytes(left: string, right: string): number {
  const a = utf8Encoder.encode(left);
  const b = utf8Encoder.encode(right);
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index++) {
    if (a[index] !== b[index]) return (a[index] ?? 0) < (b[index] ?? 0) ? -1 : 1;
  }
  return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
}

/**
 * Re-read a sealed compact target's R2 message chunks in bounded pages, before the flip lets the
 * root reclaim its copy.
 *
 * Replaces the one-RPC whole-session recompute (`readValidatedSeal`), which re-read every R2
 * chunk of the session in a single call (~0.4-0.8 ms per message in production, so 40-80 s on
 * the shard at the 100k-message cap). Each call reads chunks in ordinal order until its deadline
 * and records where it stopped, so the work spans ticks. Together the checks prove the same
 * thing the recompute did:
 * - every raw chunk's rows hash to the sha256 the ROOT computed when it exported that chunk
 *   (the commit receipt), so R2 holds exactly the rows the root exported;
 * - rows are strictly increasing in the root's export order across chunk boundaries and belong
 *   to this session, so no row is duplicated or out of place;
 * - the verified row count equals the root's prepared message count, and the flip that follows
 *   re-proves the root unchanged since then (`finalizeSourceDelete` terminal version), so the
 *   exported rows are all of the root's rows.
 */
export async function verifyArchiveTargetPage(
  sql: SqlStorage,
  env: Env,
  input: ArchiveTargetVerifyPageInput,
  options: { yieldBetweenPages?: () => Promise<void> } = {}
): Promise<ArchiveTargetVerifyPageResult> {
  let progress: VerifyProgress | null = null;
  const empty = (): ArchiveTargetVerifyPageResult => ({
    complete: false,
    chunksVerified: 0,
    rowsVerified: 0,
    nextOrdinal: progress?.nextOrdinal ?? 0,
    totalRowsVerified: progress?.rows ?? 0,
  });
  try {
    const target = readTargetSession(sql, input.sessionId);
    const state = validateTargetOwner(target, input);
    if (state !== 'sealed' && state !== 'published') {
      throw new ProjectDataArchiveInvariantError(
        'target_not_sealed',
        'ProjectData archive target must be sealed before its chunks are verified'
      );
    }
    if (!compactArchive.isCompactArchive(sql, input.sessionId)) {
      throw new ProjectDataArchiveInvariantError(
        'target_not_compact',
        'Paged archive verification applies to compact archive targets only'
      );
    }
    if (target?.terminal_version_sha256 !== input.terminalVersionSha256) {
      throw new ProjectDataArchiveInvariantError(
        'target_terminal_version_mismatch',
        'ProjectData archive target terminal version does not match the migration'
      );
    }
    progress = readVerifyProgress(
      sql,
      input.sessionId,
      input.migrationId,
      input.terminalVersionSha256
    );
    if (progress.failure) return { ...empty(), failure: progress.failure };
    if (progress.complete) return { ...empty(), complete: true };
    const outcome = await verifyChunksAndComponents(sql, env, input, target, progress, options);
    return outcome;
  } catch (error) {
    const failure = {
      reason:
        error instanceof ProjectDataArchiveInvariantError
          ? error.reason
          : 'target_chunk_read_failed',
      message: error instanceof Error ? error.message : String(error),
    };
    if (progress) {
      // A read that ran out of time is not a verdict on the copy: keep what was verified and let
      // the next call continue from it. Anything else is recorded so it is not re-read.
      if (!compactArchive.isArchiveReadOutOfTime(error)) progress.failure = failure;
      writeVerifyProgress(sql, input.sessionId, progress);
    }
    return compactArchive.isArchiveReadOutOfTime(error) ? empty() : { ...empty(), failure };
  }
}

function writeVerifyProgress(sql: SqlStorage, sessionId: string, progress: VerifyProgress): void {
  sql.exec(
    'INSERT OR REPLACE INTO do_meta (key, value) VALUES (?, ?)',
    VERIFY_PROGRESS_META_PREFIX + sessionId,
    JSON.stringify(progress)
  );
}

async function verifyChunksAndComponents(
  sql: SqlStorage,
  env: Env,
  input: ArchiveTargetVerifyPageInput,
  target: Record<string, unknown> | null,
  progress: VerifyProgress,
  options: { yieldBetweenPages?: () => Promise<void> }
): Promise<ArchiveTargetVerifyPageResult> {
  const expectedMessageCount = strictInteger(
    target?.expected_message_count,
    'target.expected_message_count'
  );
  const perChunkTimeoutMs = compactArchiveTimeout(env.PROJECT_DATA_ARCHIVE_R2_TIMEOUT_MS);
  let chunksVerified = 0;
  let rowsVerified = 0;
  let exhausted = true;
  try {
    for await (const chunk of compactArchive.compactRawChunks(sql, env, input.sessionId, {
      perChunkTimeoutMs,
      ...(progress.nextOrdinal > 0 ? { startAfterOrdinal: progress.nextOrdinal - 1 } : {}),
    })) {
      if (chunk.ordinal !== progress.nextOrdinal) {
        throw new ProjectDataArchiveInvariantError(
          'target_chunk_inventory_gap',
          'Compact archive raw chunk inventory has a gap'
        );
      }
      if (chunk.sessionId !== input.sessionId || chunk.migrationId !== input.migrationId) {
        throw new ProjectDataArchiveInvariantError(
          'target_chunk_identity_mismatch',
          'Compact archive raw chunk belongs to another session or migration'
        );
      }
      const receipt = sql
        .exec(
          `SELECT sha256, row_count FROM project_data_archive_target_chunks
           WHERE session_id = ? AND migration_id = ? AND table_name = 'chat_messages' AND ordinal = ?`,
          input.sessionId,
          input.migrationId,
          chunk.ordinal
        )
        .toArray()[0];
      if (!receipt || receipt.sha256 !== chunk.sha256 || receipt.row_count !== chunk.rows.length) {
        throw new ProjectDataArchiveInvariantError(
          'target_chunk_receipt_mismatch',
          'Compact archive raw chunk does not match the hash the root exported'
        );
      }
      // Validate the whole chunk before taking any of it into the saved progress.
      let lastKey = progress.lastKey;
      for (const row of chunk.rows) {
        if (row.session_id !== input.sessionId) {
          throw new ProjectDataArchiveInvariantError(
            'target_chunk_identity_mismatch',
            'Compact archive raw chunk holds a row of another session'
          );
        }
        const key = messageOrderKey(row);
        if (lastKey && compareMessageOrderKeys(lastKey, key) >= 0) {
          throw new ProjectDataArchiveInvariantError(
            'target_chunk_order_mismatch',
            'Compact archive rows are not in strictly increasing export order'
          );
        }
        lastKey = key;
      }
      progress.lastKey = lastKey;
      progress.nextOrdinal++;
      progress.rows += chunk.rows.length;
      chunksVerified++;
      rowsVerified += chunk.rows.length;
      if (Date.now() >= input.deadlineAt) {
        exhausted = false;
        break;
      }
    }
  } catch (error) {
    // Keep the chunks this call did verify, whatever stopped it.
    writeVerifyProgress(sql, input.sessionId, progress);
    throw error;
  }
  const result = (complete: boolean): ArchiveTargetVerifyPageResult => ({
    complete,
    chunksVerified,
    rowsVerified,
    nextOrdinal: progress.nextOrdinal,
    totalRowsVerified: progress.rows,
  });
  if (!exhausted) {
    writeVerifyProgress(sql, input.sessionId, progress);
    return result(false);
  }
  const receiptCount = countRows(
    sql,
    `SELECT COUNT(*) AS count FROM project_data_archive_target_chunks
     WHERE session_id = ? AND migration_id = ? AND table_name = 'chat_messages'`,
    input.sessionId,
    input.migrationId
  );
  if (receiptCount !== progress.nextOrdinal || progress.rows !== expectedMessageCount) {
    throw new ProjectDataArchiveInvariantError(
      'target_message_count_mismatch',
      'Compact archive verified rows do not match the prepared source count'
    );
  }
  await assertTargetComponentsMatch(sql, input, options.yieldBetweenPages);
  progress.complete = true;
  writeVerifyProgress(sql, input.sessionId, progress);
  return result(true);
}

/**
 * The shard-local half of the pre-flip proof. The R2 pages prove the message rows; this proves
 * the session anchor, grouped rows and tool-payload archives the shard holds in its own SQLite
 * equal what the root hashed at prepare. Comments are never copied (the root refuses to archive
 * a session that has any), so the root's counts must be zero.
 */
async function assertTargetComponentsMatch(
  sql: SqlStorage,
  input: ArchiveTargetVerifyPageInput,
  yieldBetweenPages?: () => Promise<void>
): Promise<void> {
  const expected = input.expectedComponents;
  const mismatch = (component: string) =>
    new ProjectDataArchiveInvariantError(
      'target_component_mismatch',
      `ProjectData archive target ${component} does not match the root's prepared terminal version`
    );
  const anchorRow = readSessionAnchor(sql, input.sessionId);
  if (
    !anchorRow ||
    (await sha256Hex(canonicalizeArchiveRow(CHAT_SESSION_ANCHOR_COLUMNS, anchorRow))) !==
      expected.anchorSha256
  ) {
    throw mismatch('session anchor');
  }
  if (expected.commentThreads !== 0 || expected.commentReplies !== 0) throw mismatch('comments');
  const pageRows = resolveHashPageRows(undefined);
  if (
    (await tableAggregateSha256(
      sql,
      'chat_messages_grouped',
      input.sessionId,
      pageRows,
      yieldBetweenPages
    )) !== expected.groupedSha256
  ) {
    throw mismatch('grouped rows');
  }
  if (
    (await tableAggregateSha256(
      sql,
      'tool_payload_archives',
      input.sessionId,
      pageRows,
      yieldBetweenPages
    )) !== expected.toolPayloadArchivesSha256
  ) {
    throw mismatch('tool-payload archives');
  }
}

/** Drop a paged verification's progress and verdict, e.g. when the target is abandoned. */
export function clearArchiveTargetVerifyProgress(sql: SqlStorage, sessionId: string): void {
  sql.exec('DELETE FROM do_meta WHERE key = ?', VERIFY_PROGRESS_META_PREFIX + sessionId);
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
      `SELECT table_name, ordinal, sha256, row_count, byte_count,
              source_cursor, source_has_more
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
        sourceCursor: row.source_cursor === null ? null : String(row.source_cursor),
        sourceHasMore:
          row.source_has_more === null
            ? null
            : strictInteger(row.source_has_more, 'target_chunk.source_has_more') === 1,
        ...(() => {
          if (tableName !== 'chat_messages') return {};
          const ref = sql
            .exec(
              'SELECT * FROM project_data_archive_raw_chunks WHERE session_id = ? AND ordinal = ?',
              sessionId,
              row.ordinal
            )
            .toArray()[0];
          return ref
            ? {
                r2Key: String(ref.r2_key),
                rawChunkRef: {
                  key: String(ref.r2_key),
                  bytes: Number(ref.compressed_bytes),
                  bodyBytes: Number(ref.body_bytes),
                  bodySha256: String(ref.body_sha256),
                },
              }
            : {};
        })(),
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
    storageFormat: strictString(
      target?.storage_format ?? LEGACY_ARCHIVE_FORMAT,
      'target.storage_format'
    ),
    state,
    terminalVersionSha256: strictString(
      target?.terminal_version_sha256,
      'target.terminal_version_sha256'
    ),
    aggregateSha256: optionalNonEmptyString(target?.aggregate_sha256),
    messageCount: compactArchive.isCompactArchive(sql, input.sessionId)
      ? compactArchive.compactMessageCount(sql, input.sessionId)
      : countRows(
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

async function compactExportPage(
  sql: SqlStorage,
  env: Env | undefined,
  input: { sessionId: string; tableName: ProjectDataArchiveTableName; cursor?: string | null },
  limit: number
) {
  if (
    !env ||
    input.tableName !== 'chat_messages' ||
    !compactArchive.isCompactArchive(sql, input.sessionId)
  )
    return null;
  const rawCursor = input.cursor ? decodeCursor(input.cursor, 3) : null;
  const cursor = rawCursor
    ? {
        createdAt: Number(cursorPart(rawCursor, 0)),
        sequence: Number(cursorPart(rawCursor, 1)),
        id: cursorPart(rawCursor, 2),
      }
    : null;
  return compactArchive.compactExportCandidates(sql, env, input.sessionId, limit, cursor);
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
  },
  compactEnv?: Env
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
  const compactCandidates = await compactExportPage(sql, compactEnv, input, maxRows + 1);
  const candidates: Iterable<Record<string, unknown>> =
    compactCandidates?.rows ?? sql.exec(query, ...params);
  const rows: ProjectDataArchiveRow[] = [];
  let byteCount = 0;
  let transportByteCount = 0;
  const transportByteBudget = Math.min(maxBytes, messages.RPC_SIZE_BUDGET_BYTES);
  let hasMore = compactCandidates?.hasMore ?? false;
  for (const candidate of candidates) {
    if (rows.length === maxRows) {
      hasMore = true;
      break;
    }
    const row = toArchiveRow(candidate, spec.columns);
    const rowId = strictString(row[spec.keyColumn], `${input.tableName}.${spec.keyColumn}`);
    const candidateBytes = byteLength(canonicalizeArchiveRow(spec.columns, row));
    const candidateTransportBytes =
      byteLength(JSON.stringify(row)) +
      byteLength(JSON.stringify(rowId)) +
      // One comma in each of the rows and rowIds arrays after the first row.
      (rows.length > 0 ? 2 : 0);
    if (
      candidateBytes > messages.RPC_SIZE_BUDGET_BYTES ||
      candidateTransportBytes > messages.RPC_SIZE_BUDGET_BYTES
    ) {
      throw new ProjectDataArchiveInvariantError(
        'archive_row_exceeds_chunk_budget',
        'ProjectData archive row exceeds the Durable Object RPC byte ceiling'
      );
    }
    if (
      byteCount + candidateBytes > maxBytes ||
      transportByteCount + candidateTransportBytes > transportByteBudget
    ) {
      // A single valid row may exceed the configured target chunk size. Returning
      // it alone gives the migration a finite, integrity-preserving path while the
      // absolute RPC ceiling above still bounds memory and transport size.
      if (rows.length === 0) {
        rows.push(row);
        byteCount = candidateBytes;
        transportByteCount = candidateTransportBytes;
      }
      hasMore = true;
      break;
    }
    rows.push(row);
    byteCount += candidateBytes;
    transportByteCount += candidateTransportBytes;
  }
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
  input: ArchiveTargetExportChunkInput,
  env?: Env
): Promise<ProjectDataArchiveChunk> {
  const state = validateTargetOwner(readTargetSession(sql, input.sessionId), input);
  if (state !== 'sealed' && state !== 'published' && state !== 'rehome_exported') {
    throw new ProjectDataArchiveInvariantError(
      'target_not_exportable',
      'ProjectData archive target is not exportable for re-home or copy-back'
    );
  }
  return exportArchiveRowsChunk(
    sql,
    {
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
    },
    env
  );
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

const ARCHIVE_SEARCH_INDEX_VERSION = 2;
const ARCHIVE_SEARCH_DOCUMENT_COLUMNS = [
  'projection_id',
  'document_id',
  'session_id',
  'role',
  'content',
  'created_at',
] as const;
const ARCHIVE_SEARCH_GROUPABLE_ROLES = new Set(['assistant', 'tool', 'thinking']);

export type ArchiveSearchCoverage = {
  version: number;
  state: 'complete';
  messageCount: number;
  documentCount: number;
  sha256: string;
  compactRawEvidence?: CompactRawEvidence;
};

type PendingArchiveSearchDocument = {
  projectionId: string;
  documentId: string;
  role: string;
  content: string;
  createdAt: number;
};

function clearArchiveSearchProjection(sql: SqlStorage, sessionId: string, pageRows: number): void {
  let cursor = 0;
  for (;;) {
    const rows = sql
      .exec(
        `SELECT rowid, content
         FROM project_data_archive_search_documents
         WHERE session_id = ? AND rowid > ?
         ORDER BY rowid ASC LIMIT ?`,
        sessionId,
        cursor,
        pageRows
      )
      .toArray();
    if (rows.length === 0) break;
    for (const row of rows) {
      const rowid = strictInteger(row.rowid, 'archive_search.rowid');
      const content = strictString(row.content, 'archive_search.content');
      sql.exec(
        `INSERT INTO project_data_archive_search_documents_fts(
           project_data_archive_search_documents_fts, rowid, content
         ) VALUES('delete', ?, ?)`,
        rowid,
        content
      );
      sql.exec('DELETE FROM project_data_archive_search_documents WHERE rowid = ?', rowid);
      cursor = rowid;
    }
  }
}

function insertArchiveSearchDocument(
  sql: SqlStorage,
  sessionId: string,
  document: PendingArchiveSearchDocument,
  hasher?: { update(row: Record<string, unknown>): void }
): void {
  const row = {
    projection_id: document.projectionId,
    document_id: document.documentId,
    session_id: sessionId,
    role: document.role,
    content: document.content,
    created_at: document.createdAt,
  };
  const inserted = sql
    .exec(
      `INSERT OR IGNORE INTO project_data_archive_search_documents (
         projection_id, document_id, session_id, role, content, created_at
       ) VALUES (?, ?, ?, ?, ?, ?) RETURNING rowid`,
      document.projectionId,
      document.documentId,
      sessionId,
      document.role,
      document.content,
      document.createdAt
    )
    .toArray()[0];
  if (inserted) {
    const rowid = strictInteger(inserted.rowid, 'archive_search.inserted_rowid');
    sql.exec(
      'INSERT INTO project_data_archive_search_documents_fts(rowid, content) VALUES (?, ?)',
      rowid,
      document.content
    );
  } else {
    const existing = sql
      .exec(
        `SELECT rowid, document_id, session_id, role, content, created_at
         FROM project_data_archive_search_documents WHERE projection_id = ?`,
        document.projectionId
      )
      .toArray()[0];
    if (
      !existing ||
      existing.document_id !== document.documentId ||
      existing.session_id !== sessionId ||
      existing.role !== document.role ||
      existing.content !== document.content ||
      existing.created_at !== document.createdAt
    ) {
      throw new ProjectDataArchiveInvariantError(
        'archive_search_projection_conflict',
        'Archive search projection identity was reused with different content'
      );
    }
    const rowid = strictInteger(existing.rowid, 'archive_search.existing_rowid');
    const ftsRow = sql
      .exec('SELECT rowid FROM project_data_archive_search_documents_fts WHERE rowid = ?', rowid)
      .toArray()[0];
    if (!ftsRow) {
      sql.exec(
        'INSERT INTO project_data_archive_search_documents_fts(rowid, content) VALUES (?, ?)',
        rowid,
        document.content
      );
    }
  }
  hasher?.update(row);
}

/**
 * Build the compact archive search projection from the chunk that was already
 * fetched and authenticated for target commit. The caller commits this state,
 * the compact chunk reference, and the copy receipt in one SQLite transaction,
 * so a reset never leaves projection progress ahead of the durable receipt.
 */
function commitCompactSearchProjectionChunk(
  sql: SqlStorage,
  env: Env,
  input: ArchiveTargetCommitChunkInput,
  rows: ProjectDataArchiveRow[]
): void {
  if (input.tableName !== 'chat_messages' && input.tableName !== 'chat_messages_grouped') return;
  const pageRows = resolveHashPageRows(
    Number.parseInt(env.PROJECT_DATA_ARCHIVE_HASH_PAGE_ROWS ?? '', 10)
  );
  const target = sql
    .exec(
      `SELECT search_index_state, search_repair_phase, search_repair_next_ordinal,
              search_repair_pending_json, search_repair_message_count,
              search_repair_projection_sha256, search_repair_document_count
       FROM project_data_archive_target_sessions WHERE session_id = ?`,
      input.sessionId
    )
    .toArray()[0];
  if (!target) throw new Error('Compact archive target session is missing');

  let phase: 'raw' | 'grouped';
  let nextOrdinal: number;
  let pending: PendingArchiveSearchDocument | null;
  let messageCount: number;
  let chain: ReturnType<typeof createCanonicalRowsChainHasher>;
  if (target.search_index_state !== 'repairing') {
    if (input.tableName !== 'chat_messages' || input.ordinal !== 0) {
      throw new ProjectDataArchiveInvariantError(
        'archive_search_copy_order_invalid',
        'Compact archive projection must start with raw chunk zero'
      );
    }
    clearArchiveSearchProjection(sql, input.sessionId, pageRows);
    phase = 'raw';
    nextOrdinal = 0;
    pending = null;
    messageCount = 0;
    chain = createCanonicalRowsChainHasher(ARCHIVE_SEARCH_DOCUMENT_COLUMNS);
    sql.exec(
      `UPDATE project_data_archive_target_sessions
       SET search_index_version = ?, search_index_state = 'repairing',
           search_index_message_count = NULL, search_index_document_count = NULL,
           search_index_sha256 = NULL, search_indexed_at = NULL,
           search_repair_phase = 'raw', search_repair_next_ordinal = 0,
           search_repair_raw_cursor = NULL, search_repair_grouped_cursor = NULL,
           search_repair_pending_json = NULL, search_repair_message_count = 0,
           search_repair_projection_sha256 = ?, search_repair_document_count = 0,
           updated_at = ?
       WHERE session_id = ?`,
      ARCHIVE_SEARCH_INDEX_VERSION,
      chain.digestHex,
      input.now,
      input.sessionId
    );
  } else {
    const storedPhase = strictString(target.search_repair_phase, 'archive_search.repair_phase');
    if (storedPhase !== 'raw' && storedPhase !== 'grouped') {
      throw new ProjectDataArchiveInvariantError(
        'archive_search_repair_phase_invalid',
        'Compact archive search projection phase is invalid'
      );
    }
    phase = storedPhase;
    nextOrdinal = strictInteger(
      target.search_repair_next_ordinal,
      'archive_search.repair_next_ordinal'
    );
    pending = parsePendingArchiveSearchDocument(target.search_repair_pending_json);
    messageCount = strictInteger(
      target.search_repair_message_count,
      'archive_search.repair_message_count'
    );
    chain = createCanonicalRowsChainHasher(ARCHIVE_SEARCH_DOCUMENT_COLUMNS, {
      digestHex: strictString(
        target.search_repair_projection_sha256,
        'archive_search.repair_projection_sha256'
      ),
      rowCount: strictInteger(
        target.search_repair_document_count,
        'archive_search.repair_document_count'
      ),
    });
  }

  const expectedPhase = input.tableName === 'chat_messages' ? 'raw' : 'grouped';
  if (phase !== expectedPhase || nextOrdinal !== input.ordinal) {
    throw new ProjectDataArchiveInvariantError(
      'archive_search_copy_order_invalid',
      'Compact archive projection chunk order does not match copy order'
    );
  }
  const commitDocument = (document: PendingArchiveSearchDocument) => {
    insertArchiveSearchDocument(sql, input.sessionId, document);
    chain.update({
      projection_id: document.projectionId,
      document_id: document.documentId,
      session_id: input.sessionId,
      role: document.role,
      content: document.content,
      created_at: document.createdAt,
    });
  };
  const flush = () => {
    if (!pending) return;
    commitDocument(pending);
    pending = null;
  };

  if (phase === 'raw') {
    const maxGroupChars = resolveMaterializationPassConfig(env).maxGroupChars;
    for (const row of rows) {
      if ((row.origin ?? 'user') === 'system') continue;
      const role = strictString(row.role, 'archive_search.role');
      const content = strictString(row.content, 'archive_search.content');
      const id = strictString(row.id, 'archive_search.message_id');
      const createdAt = strictInteger(row.created_at, 'archive_search.created_at');
      strictInteger(row.sequence, 'archive_search.sequence');
      messageCount++;
      if (
        pending?.role === role &&
        ARCHIVE_SEARCH_GROUPABLE_ROLES.has(role) &&
        pending.content.length < maxGroupChars
      ) {
        pending.content += content;
      } else {
        flush();
        pending = {
          projectionId: `raw:${input.sessionId}:${id}`,
          documentId: id,
          role,
          content,
          createdAt,
        };
      }
    }
    nextOrdinal++;
    if (!input.hasMore) {
      flush();
      phase = 'grouped';
      nextOrdinal = 0;
    }
  } else {
    for (const row of rows) {
      const documentId = strictString(row.id, 'archive_search.grouped_id');
      const content = strictString(row.content, 'archive_search.grouped_content');
      const groupedRow = sql
        .exec('SELECT rowid FROM chat_messages_grouped WHERE id = ?', documentId)
        .toArray()[0];
      if (!groupedRow) {
        throw new ProjectDataArchiveInvariantError(
          'target_chunk_missing_rows',
          'Compact archive grouped row is missing during projection commit'
        );
      }
      sql.exec(
        'INSERT OR IGNORE INTO chat_messages_grouped_fts(rowid, content) VALUES (?, ?)',
        strictInteger(groupedRow.rowid, 'archive_search.grouped_rowid'),
        content
      );
      const equivalent = sql
        .exec(
          `SELECT 1 AS present FROM project_data_archive_search_documents
           WHERE session_id = ? AND document_id = ? AND content = ? LIMIT 1`,
          input.sessionId,
          documentId,
          content
        )
        .toArray()[0];
      if (!equivalent) {
        commitDocument({
          projectionId: `grouped:${input.sessionId}:${documentId}`,
          documentId,
          role: strictString(row.role, 'archive_search.grouped_role'),
          content,
          createdAt: strictInteger(row.created_at, 'archive_search.grouped_created_at'),
        });
      }
    }
    nextOrdinal++;
  }

  if (phase === 'grouped' && input.tableName === 'chat_messages_grouped' && !input.hasMore) {
    const documentCount = countRows(
      sql,
      'SELECT COUNT(*) AS count FROM project_data_archive_search_documents WHERE session_id = ?',
      input.sessionId
    );
    const indexed = countRows(
      sql,
      `SELECT COUNT(*) AS count
       FROM project_data_archive_search_documents_fts f
       JOIN project_data_archive_search_documents d ON d.rowid = f.rowid
       WHERE d.session_id = ?`,
      input.sessionId
    );
    if (documentCount !== chain.rowCount || indexed !== documentCount) {
      throw new ProjectDataArchiveInvariantError(
        'archive_search_index_verification_failed',
        'Compact archive search projection failed count and FTS verification'
      );
    }
    sql.exec(
      `UPDATE project_data_archive_target_sessions
       SET search_index_version = ?, search_index_state = 'complete',
           search_index_message_count = ?, search_index_document_count = ?,
           search_index_sha256 = ?, search_indexed_at = ?,
           search_repair_phase = NULL, search_repair_next_ordinal = NULL,
           search_repair_raw_cursor = NULL, search_repair_grouped_cursor = NULL,
           search_repair_pending_json = NULL, search_repair_message_count = NULL,
           search_repair_projection_sha256 = NULL, search_repair_document_count = NULL,
           updated_at = ?
       WHERE session_id = ?`,
      ARCHIVE_SEARCH_INDEX_VERSION,
      messageCount,
      documentCount,
      chain.digestHex,
      input.now,
      input.now,
      input.sessionId
    );
    return;
  }

  sql.exec(
    `UPDATE project_data_archive_target_sessions
     SET search_repair_phase = ?, search_repair_next_ordinal = ?,
         search_repair_pending_json = ?, search_repair_message_count = ?,
         search_repair_projection_sha256 = ?, search_repair_document_count = ?,
         updated_at = ?
     WHERE session_id = ?`,
    phase,
    nextOrdinal,
    pending ? JSON.stringify(pending) : null,
    messageCount,
    chain.digestHex,
    chain.rowCount,
    input.now,
    input.sessionId
  );
}

async function rebuildArchiveSearchProjection(
  sql: SqlStorage,
  env: Env | undefined,
  sessionId: string,
  now: number
): Promise<ArchiveSearchCoverage> {
  const pageRows = resolveHashPageRows(
    Number.parseInt(env?.PROJECT_DATA_ARCHIVE_HASH_PAGE_ROWS ?? '', 10)
  );
  const maxGroupChars = resolveMaterializationPassConfig(env ?? {}).maxGroupChars;
  sql.exec(
    `UPDATE project_data_archive_target_sessions
     SET search_index_version = ?, search_index_state = 'repairing',
         search_index_message_count = NULL, search_index_document_count = NULL,
         search_index_sha256 = NULL, search_indexed_at = NULL, updated_at = ?
     WHERE session_id = ?`,
    ARCHIVE_SEARCH_INDEX_VERSION,
    now,
    sessionId
  );
  clearArchiveSearchProjection(sql, sessionId, pageRows);

  const hasher = createCanonicalRowsChainHasher(ARCHIVE_SEARCH_DOCUMENT_COLUMNS);
  const rawHasher = createCanonicalRowsHasher(validateTableName('chat_messages').columns);
  let rawLastMessageAt: number | null = null;
  let pending: PendingArchiveSearchDocument | null = null;
  let messageCount = 0;
  let documentCount = 0;
  const flush = () => {
    if (!pending) return;
    insertArchiveSearchDocument(sql, sessionId, pending, hasher);
    documentCount++;
    pending = null;
  };
  const consume = (row: ProjectDataArchiveRow) => {
    rawHasher.update(row);
    rawLastMessageAt = strictInteger(row.created_at, 'archive_search.created_at');
    if ((row.origin ?? 'user') === 'system') return;
    const role = strictString(row.role, 'archive_search.role');
    const content = strictString(row.content, 'archive_search.content');
    const id = strictString(row.id, 'archive_search.message_id');
    const createdAt = strictInteger(row.created_at, 'archive_search.created_at');
    strictInteger(row.sequence, 'archive_search.sequence');
    messageCount++;
    if (
      pending?.role === role &&
      ARCHIVE_SEARCH_GROUPABLE_ROLES.has(role) &&
      pending.content.length < maxGroupChars
    ) {
      pending.content += content;
      return;
    }
    flush();
    pending = {
      projectionId: `raw:${sessionId}:${id}`,
      documentId: id,
      role,
      content,
      createdAt,
    };
  };

  if (compactArchive.isCompactArchive(sql, sessionId)) {
    if (!env) {
      throw new ProjectDataArchiveInvariantError(
        'archive_search_environment_required',
        'Compact ProjectData archive search projection requires the archive environment'
      );
    }
    for await (const chunk of compactArchive.compactRawChunks(sql, env, sessionId, {
      perChunkTimeoutMs: compactArchiveTimeout(env.PROJECT_DATA_ARCHIVE_R2_TIMEOUT_MS),
    })) {
      for (const row of chunk.rows) consume(row);
    }
  } else {
    const spec = validateTableName('chat_messages');
    let cursor: string | null = null;
    for (;;) {
      let query = `SELECT ${spec.columns.join(', ')}
        FROM chat_messages WHERE session_id = ?`;
      const params: Array<string | number> = [sessionId];
      if (cursor) {
        query += ` AND ${spec.cursorPredicate}`;
        params.push(...spec.cursorValues(cursor));
      }
      query += ` ORDER BY ${spec.orderBy} LIMIT ?`;
      params.push(pageRows);
      let count = 0;
      let tail: Record<string, unknown> | null = null;
      for (const raw of sql.exec(query, ...params)) {
        consume(toArchiveRow(raw, spec.columns));
        tail = raw;
        count++;
      }
      if (count < pageRows || !tail) break;
      cursor = spec.cursorFromRow(tail);
    }
  }
  flush();
  forEachGroupedRowPaged(sql, sessionId, pageRows, (row) => {
    const documentId = strictString(row.id, 'archive_search.grouped_id');
    const content = strictString(row.content, 'archive_search.grouped_content');
    const equivalent = sql
      .exec(
        `SELECT 1 AS present
         FROM project_data_archive_search_documents
         WHERE session_id = ? AND document_id = ? AND content = ?
         LIMIT 1`,
        sessionId,
        documentId,
        content
      )
      .toArray()[0];
    if (equivalent) return;
    insertArchiveSearchDocument(
      sql,
      sessionId,
      {
        projectionId: `grouped:${sessionId}:${documentId}`,
        documentId,
        role: strictString(row.role, 'archive_search.grouped_role'),
        content,
        createdAt: strictInteger(row.created_at, 'archive_search.grouped_created_at'),
      },
      hasher
    );
    documentCount++;
  });

  const indexed = countRows(
    sql,
    `SELECT COUNT(*) AS count
     FROM project_data_archive_search_documents_fts f
     JOIN project_data_archive_search_documents d ON d.rowid = f.rowid
     WHERE d.session_id = ?`,
    sessionId
  );
  if (indexed !== documentCount || hasher.rowCount !== documentCount) {
    throw new ProjectDataArchiveInvariantError(
      'archive_search_index_incomplete',
      'ProjectData archive search projection does not cover every derived document'
    );
  }
  const sha256 = hasher.digestHex;
  sql.exec(
    `UPDATE project_data_archive_target_sessions
     SET search_index_version = ?, search_index_state = 'complete',
         search_index_message_count = ?, search_index_document_count = ?,
         search_index_sha256 = ?, search_indexed_at = ?, updated_at = ?
     WHERE session_id = ?`,
    ARCHIVE_SEARCH_INDEX_VERSION,
    messageCount,
    documentCount,
    sha256,
    now,
    now,
    sessionId
  );
  return {
    version: ARCHIVE_SEARCH_INDEX_VERSION,
    state: 'complete',
    messageCount,
    documentCount,
    sha256,
    compactRawEvidence: compactArchive.isCompactArchive(sql, sessionId)
      ? {
          sha256: rawHasher.digestHex(),
          messageCount: rawHasher.rowCount,
          lastMessageAt: rawLastMessageAt,
        }
      : undefined,
  };
}

function readArchiveSearchCoverage(
  sql: SqlStorage,
  sessionId: string
): ArchiveSearchCoverage | null {
  const row = sql
    .exec(
      `SELECT search_index_version, search_index_state, search_index_message_count,
              search_index_document_count, search_index_sha256
       FROM project_data_archive_target_sessions WHERE session_id = ?`,
      sessionId
    )
    .toArray()[0];
  if (
    row?.search_index_version !== ARCHIVE_SEARCH_INDEX_VERSION ||
    row.search_index_state !== 'complete'
  ) {
    return null;
  }
  return {
    version: ARCHIVE_SEARCH_INDEX_VERSION,
    state: 'complete',
    messageCount: strictInteger(row.search_index_message_count, 'archive_search.message_count'),
    documentCount: strictInteger(row.search_index_document_count, 'archive_search.document_count'),
    sha256: strictString(row.search_index_sha256, 'archive_search.sha256'),
  };
}

function verifyArchiveSearchProjection(
  sql: SqlStorage,
  sessionId: string,
  expected: ArchiveSearchCoverage,
  pageRows: number
): void {
  const hasher = createCanonicalRowsChainHasher(ARCHIVE_SEARCH_DOCUMENT_COLUMNS);
  let documentCount = 0;
  let lastRowid = 0;
  for (;;) {
    const rows = sql
      .exec(
        `SELECT rowid, projection_id, document_id, session_id, role, content, created_at
         FROM project_data_archive_search_documents
         WHERE session_id = ? AND rowid > ?
         ORDER BY rowid ASC LIMIT ?`,
        sessionId,
        lastRowid,
        pageRows
      )
      .toArray();
    for (const row of rows) {
      lastRowid = strictInteger(row.rowid, 'archive_search.rowid');
      hasher.update({
        projection_id: strictString(row.projection_id, 'archive_search.projection_id'),
        document_id: strictString(row.document_id, 'archive_search.document_id'),
        session_id: strictString(row.session_id, 'archive_search.session_id'),
        role: strictString(row.role, 'archive_search.role'),
        content: strictString(row.content, 'archive_search.content'),
        created_at: strictInteger(row.created_at, 'archive_search.created_at'),
      });
      documentCount++;
    }
    if (rows.length < pageRows) break;
  }
  const indexed = countRows(
    sql,
    `SELECT COUNT(*) AS count
     FROM project_data_archive_search_documents_fts f
     JOIN project_data_archive_search_documents d ON d.rowid = f.rowid
     WHERE d.session_id = ?`,
    sessionId
  );
  if (
    documentCount !== expected.documentCount ||
    indexed !== expected.documentCount ||
    hasher.rowCount !== expected.documentCount ||
    hasher.digestHex !== expected.sha256
  ) {
    throw new ProjectDataArchiveInvariantError(
      'archive_search_index_verification_failed',
      'ProjectData archive search projection failed completeness verification'
    );
  }
}

async function ensureArchiveSearchCoverage(
  sql: SqlStorage,
  env: Env | undefined,
  sessionId: string,
  now: number,
  options: { verifyExisting?: boolean } = {}
): Promise<ArchiveSearchCoverage> {
  const pageRows = resolveHashPageRows(
    Number.parseInt(env?.PROJECT_DATA_ARCHIVE_HASH_PAGE_ROWS ?? '', 10)
  );
  const existing = readArchiveSearchCoverage(sql, sessionId);
  const coverage = existing ?? (await rebuildArchiveSearchProjection(sql, env, sessionId, now));
  // A complete seal is durable evidence for ordinary reads. Full projection
  // hashing stays on seal/repair/audit paths so every search does not rescan all
  // retained text. Fresh rebuilds are always verified before publication.
  if (!existing || options.verifyExisting !== false) {
    verifyArchiveSearchProjection(sql, sessionId, coverage, pageRows);
  }
  return coverage;
}

function parsePendingArchiveSearchDocument(value: unknown): PendingArchiveSearchDocument | null {
  if (value === null || value === undefined) return null;
  const parsed: unknown = typeof value === 'string' ? JSON.parse(value) : value;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Invalid archive search repair pending document');
  }
  const row = parsed as Record<string, unknown>;
  return {
    projectionId: strictString(row.projectionId, 'archive_search.pending.projection_id'),
    documentId: strictString(row.documentId, 'archive_search.pending.document_id'),
    role: strictString(row.role, 'archive_search.pending.role'),
    content: strictString(row.content, 'archive_search.pending.content'),
    createdAt: strictInteger(row.createdAt, 'archive_search.pending.created_at'),
  };
}

/**
 * Advance lazy archive-index repair by one bounded source page. Compact raw
 * history advances by immutable R2 chunk; legacy raw history and grouped
 * fallback advance by the configured hash-page size. Every phase persists its
 * cursor, projection commitment and counters, so a reset replays at most one
 * page and idempotent projection identities prevent drift.
 */
async function repairArchiveSearchProjectionStep(
  sql: SqlStorage,
  env: Env,
  sessionId: string,
  now: number
): Promise<ArchiveSearchCoverage | null> {
  const existing = readArchiveSearchCoverage(sql, sessionId);
  if (existing) return existing;
  const pageRows = resolveHashPageRows(
    Number.parseInt(env.PROJECT_DATA_ARCHIVE_HASH_PAGE_ROWS ?? '', 10)
  );
  const maxGroupChars = resolveMaterializationPassConfig(env).maxGroupChars;
  let repair = sql
    .exec(
      `SELECT search_index_state, search_repair_phase, search_repair_next_ordinal,
              search_repair_raw_cursor, search_repair_grouped_cursor,
              search_repair_pending_json, search_repair_message_count,
              search_repair_projection_sha256, search_repair_document_count
       FROM project_data_archive_target_sessions WHERE session_id = ?`,
      sessionId
    )
    .toArray()[0];
  if (repair?.search_index_state !== 'repairing') {
    clearArchiveSearchProjection(sql, sessionId, pageRows);
    const initialChain = createCanonicalRowsChainHasher(ARCHIVE_SEARCH_DOCUMENT_COLUMNS);
    sql.exec(
      `UPDATE project_data_archive_target_sessions
       SET search_index_version = ?, search_index_state = 'repairing',
           search_index_message_count = NULL, search_index_document_count = NULL,
           search_index_sha256 = NULL, search_indexed_at = NULL,
           search_repair_phase = 'raw', search_repair_next_ordinal = 0,
           search_repair_raw_cursor = NULL, search_repair_grouped_cursor = NULL,
           search_repair_pending_json = NULL, search_repair_message_count = 0,
           search_repair_projection_sha256 = ?, search_repair_document_count = 0,
           updated_at = ?
       WHERE session_id = ?`,
      ARCHIVE_SEARCH_INDEX_VERSION,
      initialChain.digestHex,
      now,
      sessionId
    );
    repair = {
      search_index_state: 'repairing',
      search_repair_phase: 'raw',
      search_repair_next_ordinal: 0,
      search_repair_raw_cursor: null,
      search_repair_grouped_cursor: null,
      search_repair_pending_json: null,
      search_repair_message_count: 0,
      search_repair_projection_sha256: initialChain.digestHex,
      search_repair_document_count: 0,
    };
  }

  let phase = strictString(repair.search_repair_phase, 'archive_search.repair_phase');
  if (phase !== 'raw' && phase !== 'grouped') {
    throw new ProjectDataArchiveInvariantError(
      'archive_search_repair_phase_invalid',
      'ProjectData archive search repair phase is invalid'
    );
  }
  let nextOrdinal = strictInteger(
    repair.search_repair_next_ordinal,
    'archive_search.repair_next_ordinal'
  );
  let rawCursor =
    repair.search_repair_raw_cursor === null
      ? null
      : strictString(repair.search_repair_raw_cursor, 'archive_search.repair_raw_cursor');
  let groupedCursor =
    repair.search_repair_grouped_cursor === null
      ? null
      : strictString(repair.search_repair_grouped_cursor, 'archive_search.repair_grouped_cursor');
  let messageCount = strictInteger(
    repair.search_repair_message_count,
    'archive_search.repair_message_count'
  );
  let pending = parsePendingArchiveSearchDocument(repair.search_repair_pending_json);
  const chain = createCanonicalRowsChainHasher(ARCHIVE_SEARCH_DOCUMENT_COLUMNS, {
    digestHex: strictString(
      repair.search_repair_projection_sha256,
      'archive_search.repair_projection_sha256'
    ),
    rowCount: strictInteger(
      repair.search_repair_document_count,
      'archive_search.repair_document_count'
    ),
  });
  const commitDocument = (document: PendingArchiveSearchDocument) => {
    insertArchiveSearchDocument(sql, sessionId, document);
    chain.update({
      projection_id: document.projectionId,
      document_id: document.documentId,
      session_id: sessionId,
      role: document.role,
      content: document.content,
      created_at: document.createdAt,
    });
  };
  const flush = () => {
    if (!pending) return;
    commitDocument(pending);
    pending = null;
  };
  const consume = (row: ProjectDataArchiveRow) => {
    if ((row.origin ?? 'user') === 'system') return;
    const role = strictString(row.role, 'archive_search.role');
    const content = strictString(row.content, 'archive_search.content');
    const id = strictString(row.id, 'archive_search.message_id');
    const createdAt = strictInteger(row.created_at, 'archive_search.created_at');
    strictInteger(row.sequence, 'archive_search.sequence');
    messageCount++;
    if (
      pending?.role === role &&
      ARCHIVE_SEARCH_GROUPABLE_ROLES.has(role) &&
      pending.content.length < maxGroupChars
    ) {
      pending.content += content;
      return;
    }
    flush();
    pending = {
      projectionId: `raw:${sessionId}:${id}`,
      documentId: id,
      role,
      content,
      createdAt,
    };
  };
  const persistProgress = () => {
    sql.exec(
      `UPDATE project_data_archive_target_sessions
       SET search_repair_phase = ?, search_repair_next_ordinal = ?,
           search_repair_raw_cursor = ?, search_repair_grouped_cursor = ?,
           search_repair_pending_json = ?, search_repair_message_count = ?,
           search_repair_projection_sha256 = ?, search_repair_document_count = ?,
           updated_at = ?
       WHERE session_id = ?`,
      phase,
      nextOrdinal,
      rawCursor,
      groupedCursor,
      pending ? JSON.stringify(pending) : null,
      messageCount,
      chain.digestHex,
      chain.rowCount,
      now,
      sessionId
    );
  };

  if (phase === 'raw') {
    let rawComplete = false;
    if (compactArchive.isCompactArchive(sql, sessionId)) {
      const configuredChunks = Number.parseInt(
        env.PROJECT_DATA_ARCHIVE_SEARCH_REPAIR_CHUNKS ?? '',
        10
      );
      const chunkLimit =
        Number.isSafeInteger(configuredChunks) && configuredChunks > 0
          ? Math.min(configuredChunks, 64)
          : 1;
      let chunksRead = 0;
      for await (const chunk of compactArchive.compactRawChunks(sql, env, sessionId, {
        perChunkTimeoutMs: compactArchiveTimeout(env.PROJECT_DATA_ARCHIVE_R2_TIMEOUT_MS),
        startAfterOrdinal: nextOrdinal - 1,
      })) {
        for (const row of chunk.rows) consume(row);
        nextOrdinal = chunk.ordinal + 1;
        chunksRead++;
        if (chunksRead >= chunkLimit) break;
      }
      const maxOrdinal = Number(
        sql
          .exec(
            `SELECT COALESCE(MAX(ordinal), -1) AS max_ordinal
             FROM project_data_archive_raw_chunks WHERE session_id = ?`,
            sessionId
          )
          .toArray()[0]?.max_ordinal ?? -1
      );
      rawComplete = nextOrdinal > maxOrdinal;
    } else {
      const spec = validateTableName('chat_messages');
      let query = `SELECT ${spec.columns.join(', ')} FROM chat_messages WHERE session_id = ?`;
      const params: Array<string | number> = [sessionId];
      if (rawCursor) {
        query += ` AND ${spec.cursorPredicate}`;
        params.push(...spec.cursorValues(rawCursor));
      }
      query += ` ORDER BY ${spec.orderBy} LIMIT ?`;
      params.push(pageRows);
      const rows = sql.exec(query, ...params).toArray();
      for (const row of rows) consume(toArchiveRow(row, spec.columns));
      const tail = rows[rows.length - 1];
      if (tail) rawCursor = spec.cursorFromRow(tail);
      rawComplete = rows.length < pageRows;
    }
    if (rawComplete) {
      flush();
      phase = 'grouped';
    }
    persistProgress();
    return null;
  }

  const groupedSpec = validateTableName('chat_messages_grouped');
  let groupedQuery = `SELECT ${groupedSpec.columns.join(', ')}
    FROM chat_messages_grouped WHERE session_id = ?`;
  const groupedParams: Array<string | number> = [sessionId];
  if (groupedCursor) {
    groupedQuery += ` AND ${groupedSpec.cursorPredicate}`;
    groupedParams.push(...groupedSpec.cursorValues(groupedCursor));
  }
  groupedQuery += ` ORDER BY ${groupedSpec.orderBy} LIMIT ?`;
  groupedParams.push(pageRows);
  const groupedRows = sql.exec(groupedQuery, ...groupedParams).toArray();
  for (const row of groupedRows) {
    const documentId = strictString(row.id, 'archive_search.grouped_id');
    const content = strictString(row.content, 'archive_search.grouped_content');
    const equivalent = sql
      .exec(
        `SELECT 1 AS present FROM project_data_archive_search_documents
         WHERE session_id = ? AND document_id = ? AND content = ? LIMIT 1`,
        sessionId,
        documentId,
        content
      )
      .toArray()[0];
    if (!equivalent) {
      commitDocument({
        projectionId: `grouped:${sessionId}:${documentId}`,
        documentId,
        role: strictString(row.role, 'archive_search.grouped_role'),
        content,
        createdAt: strictInteger(row.created_at, 'archive_search.grouped_created_at'),
      });
    }
  }
  const groupedTail = groupedRows[groupedRows.length - 1];
  if (groupedTail) groupedCursor = groupedSpec.cursorFromRow(groupedTail);
  if (groupedRows.length >= pageRows) {
    persistProgress();
    return null;
  }

  const documentCount = countRows(
    sql,
    'SELECT COUNT(*) AS count FROM project_data_archive_search_documents WHERE session_id = ?',
    sessionId
  );
  const indexed = countRows(
    sql,
    `SELECT COUNT(*) AS count
     FROM project_data_archive_search_documents_fts f
     JOIN project_data_archive_search_documents d ON d.rowid = f.rowid
     WHERE d.session_id = ?`,
    sessionId
  );
  if (documentCount !== chain.rowCount || indexed !== documentCount) {
    throw new ProjectDataArchiveInvariantError(
      'archive_search_index_verification_failed',
      'ProjectData archive search repair failed count and FTS verification'
    );
  }
  const coverage: ArchiveSearchCoverage = {
    version: ARCHIVE_SEARCH_INDEX_VERSION,
    state: 'complete',
    messageCount,
    documentCount,
    sha256: chain.digestHex,
  };
  sql.exec(
    `UPDATE project_data_archive_target_sessions
     SET search_index_version = ?, search_index_state = 'complete',
         search_index_message_count = ?, search_index_document_count = ?,
         search_index_sha256 = ?, search_indexed_at = ?,
         search_repair_phase = NULL, search_repair_next_ordinal = NULL,
         search_repair_raw_cursor = NULL, search_repair_grouped_cursor = NULL,
         search_repair_pending_json = NULL, search_repair_message_count = NULL,
         search_repair_projection_sha256 = NULL, search_repair_document_count = NULL,
         updated_at = ?
     WHERE session_id = ?`,
    ARCHIVE_SEARCH_INDEX_VERSION,
    messageCount,
    documentCount,
    coverage.sha256,
    now,
    now,
    sessionId
  );
  return coverage;
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
  if (
    state === 'source_deleted' &&
    !isCopyBackInProgress(sql, input.sessionId, input.migrationId)
  ) {
    // A copy-back over leftover rows would re-index grouped rows the FTS already holds, and
    // duplicate FTS5 postings corrupt the project's search index. The coordinator drains
    // reclaim first (`copyBackProjectDataArchiveMigration`); this refuses if it did not.
    if (sourceStillOwnsRows(sql, input.sessionId)) {
      throw new ProjectDataArchiveInvariantError(
        'copy_back_reclaim_outstanding',
        'ProjectData archive copy-back cannot start while the flipped session still has rows to reclaim'
      );
    }
  }
  if (state === 'source_deleted') {
    // Fence reclaim before the first restored row lands (`isCopyBackInProgress`).
    sql.exec(
      'INSERT OR REPLACE INTO do_meta (key, value) VALUES (?, ?)',
      COPY_BACK_IN_PROGRESS_META_PREFIX + input.sessionId,
      input.migrationId
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
  // The intent is now `rehome_exported`, which reclaim already refuses, so the fence can go.
  sql.exec(
    'DELETE FROM do_meta WHERE key = ?',
    COPY_BACK_IN_PROGRESS_META_PREFIX + input.sessionId
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
  clearArchiveSearchProjection(sql, input.sessionId, resolveHashPageRows(input.hashPageRows));
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
  clearArchiveTargetVerifyProgress(sql, input.sessionId);
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

export type ArchiveTargetAbandonPageResult = {
  /** True when the target session is gone (or never existed); false while rows remain. */
  removed: boolean;
  remaining: boolean;
  rowsDeleted: number;
};

/**
 * `abandonArchiveTargetSession` in bounded pages, for unwinding a large copy. A compact target
 * of a 100k-message session holds tens of thousands of grouped rows and search documents, each
 * needing an FTS delete marker; deleting them in one transaction risks the object's CPU limit,
 * and a reset there would leave the unwind half done. Each call deletes at most `maxRows` rows in
 * one transaction; the session's target row goes last, so every page re-validates the same
 * target. Same preconditions as the one-shot abandon.
 */
export function abandonArchiveTargetSessionPage(
  sql: SqlStorage,
  input: ArchiveTargetAbandonInput & { maxRows: number },
  transactionSync: <T>(callback: () => T) => T = (callback) => callback()
): ArchiveTargetAbandonPageResult {
  const target = readTargetSession(sql, input.sessionId);
  if (!target) return { removed: true, remaining: false, rowsDeleted: 0 };
  const state = validateTargetOwner(target, input);
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
  const maxRows = Math.min(ARCHIVE_RECLAIM_MAX_PAGE_ROWS, Math.max(1, Math.floor(input.maxRows)));
  return transactionSync(() => {
    let budget = maxRows;
    let rowsDeleted = 0;
    const grouped = sql
      .exec(
        'SELECT rowid, content FROM chat_messages_grouped WHERE session_id = ? LIMIT ?',
        input.sessionId,
        budget
      )
      .toArray();
    for (const row of grouped) {
      try {
        sql.exec(
          `INSERT INTO chat_messages_grouped_fts(chat_messages_grouped_fts, rowid, content)
           VALUES('delete', ?, ?)`,
          row.rowid,
          row.content
        );
      } catch (error) {
        if (isDurableObjectSqliteNoMemError(error)) throw error;
        log.warn('archive_target_abandon_fts_delete_marker_failed', {
          sessionId: input.sessionId,
          rowid: row.rowid,
          ...serializeError(error),
        });
      }
      rowsDeleted +=
        sql.exec('DELETE FROM chat_messages_grouped WHERE rowid = ?', row.rowid).rowsWritten ?? 0;
    }
    budget -= grouped.length;
    if (budget > 0) {
      const documents = sql
        .exec(
          `SELECT rowid, content FROM project_data_archive_search_documents
           WHERE session_id = ? LIMIT ?`,
          input.sessionId,
          budget
        )
        .toArray();
      for (const row of documents) {
        sql.exec(
          `INSERT INTO project_data_archive_search_documents_fts(
             project_data_archive_search_documents_fts, rowid, content
           ) VALUES('delete', ?, ?)`,
          row.rowid,
          row.content
        );
        rowsDeleted +=
          sql.exec('DELETE FROM project_data_archive_search_documents WHERE rowid = ?', row.rowid)
            .rowsWritten ?? 0;
      }
      budget -= documents.length;
    }
    for (const table of ['tool_payload_archives', 'chat_messages'] as const) {
      if (budget <= 0) break;
      const deleted =
        sql.exec(
          `DELETE FROM ${table} WHERE rowid IN (
             SELECT rowid FROM ${table} WHERE session_id = ? LIMIT ?)`,
          input.sessionId,
          budget
        ).rowsWritten ?? 0;
      rowsDeleted += deleted;
      budget -= deleted;
    }
    if (budget <= 0) return { removed: false, remaining: true, rowsDeleted };
    // Everything row-sized is gone; the rest is one session's metadata.
    sql.exec(
      'DELETE FROM project_data_archive_target_chunks WHERE session_id = ? AND migration_id = ?',
      input.sessionId,
      input.migrationId
    );
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
    clearArchiveTargetVerifyProgress(sql, input.sessionId);
    return { removed: true, remaining: false, rowsDeleted };
  });
}

/**
 * Give a resumed claim its own source-intent token without re-running the prepare, so the root's
 * token check (`assertMatchingSourceIntent`) keeps rejecting a predecessor claim's late calls.
 * O(1): no hash. Refuses once the session has flipped.
 */
export function reattachArchiveSourceToken(
  sql: SqlStorage,
  input: ArchiveSourceInspectIntentInput & { sourceIntentToken: string; now: number }
): boolean {
  validateRootSourceOwner(input);
  const intent = readSourceIntent(sql, input.sessionId);
  const state = assertSameSourceIntentMigration(intent, input);
  if (state === 'source_deleted' || state === 'rehome_exported') return false;
  reattachSourceIntentToken(sql, input, state);
  return true;
}

export async function finalizeSourceDelete(
  sql: SqlStorage,
  input: ArchiveSourceFinalizeDeleteInput,
  transactionSync: <T>(callback: () => T) => T = (callback) => callback(),
  options: { proveByWriteGeneration?: boolean } = {}
): Promise<ArchiveSourceFinalizeDeleteResult> {
  validateRootSourceOwner(input);
  const intent = readSourceIntent(sql, input.sessionId);
  const state = assertMatchingSourceIntent(intent, input);
  if (
    intent?.terminal_version_sha256 !== input.expectedTerminalVersionSha256 ||
    intent.target_aggregate_sha256 !== input.targetAggregateSha256 ||
    intent.recovery_manifest_key !== input.r2ManifestKey
  ) {
    throw new ProjectDataArchiveInvariantError(
      'source_finalization_proof_mismatch',
      'ProjectData archive source delete proof does not match persisted recovery evidence'
    );
  }
  if (state === 'source_deleted') {
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
  // Prove the root unchanged since prepare. A prepare that recorded its write generation
  // (migration 076 triggers) is proven in O(1): any write to the hashed rows since then moved the
  // generation. Intents prepared before that, and coordinators calling the legacy
  // `archiveSourceFinalizeDelete`, re-hash the whole session as before.
  const preparedGeneration = optionalInteger(intent?.prepared_write_generation);
  let lastMessageAt: number | null;
  if (options.proveByWriteGeneration && preparedGeneration !== null) {
    if (readArchiveWriteGeneration(sql, input.sessionId) !== preparedGeneration) {
      throw new ProjectDataArchiveInvariantError(
        'terminal_version_changed',
        'ProjectData archive source was written after its terminal version was prepared'
      );
    }
    lastMessageAt = optionalInteger(intent?.last_message_at);
  } else {
    const hashPageRows = resolveHashPageRows(input.hashPageRows);
    const terminalVersion = await computeTerminalVersion(sql, input.sessionId, { hashPageRows });
    if (terminalVersion.sha256 !== input.expectedTerminalVersionSha256) {
      throw new ProjectDataArchiveInvariantError(
        'terminal_version_changed',
        'ProjectData archive terminal version changed before source delete'
      );
    }
    lastMessageAt = terminalVersion.lastMessageAt;
  }

  // The flip: the routing anchors and the `source_deleted` intent commit in one SQLite
  // transaction, and NO transcript rows are deleted here. Deleting a whole session in this
  // transaction held the root object for up to ~5.5 s at 9k messages in production
  // (2026-11-12) and would be ~60 s at the 100k-message cap. The rows are reclaimed afterwards
  // in bounded pages by `reclaimArchiveSourcePage`. Until then they are unreachable: exact reads
  // fail closed on the `source_deleted` intent, routing points at the shard, and project search
  // dedupes by (sessionId, id).
  return transactionSync(() => {
    const databaseSizeBeforeBytes = databaseSize(sql);
    sql.exec(
      `UPDATE chat_sessions
       SET archive_last_message_at = ?,
           archive_owner_name = ?,
           archive_generation = ?,
           archive_migration_id = ?,
           archive_state = 'source_deleted',
           updated_at = updated_at
       WHERE id = ?`,
      lastMessageAt,
      input.targetOwnerName,
      input.targetGeneration,
      input.migrationId,
      input.sessionId
    );
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
      databaseSizeBeforeBytes,
      input.now,
      input.sessionId,
      input.migrationId,
      input.sourceIntentToken
    );
    sql.exec(
      'INSERT OR REPLACE INTO do_meta (key, value) VALUES (?, ?)',
      RECLAIM_PENDING_META_PREFIX + input.sessionId,
      input.migrationId
    );
    return {
      idempotent: false,
      lastMessageAt: lastMessageAt,
      messagesDeleted: 0,
      groupedRowsDeleted: 0,
      ftsRowsDeleted: 0,
      toolArchiveRowsDeleted: 0,
      databaseSizeBeforeBytes,
      databaseSizeAfterBytes: databaseSizeBeforeBytes,
    };
  });
}

/**
 * Disagreements the flip may find between the root and the copy it is about to publish that
 * mean "this session changed or became busy after it was fenced", not "the archive is corrupt".
 * Each one is the root's own eligibility or terminal-version check. The root still holds every
 * row, so the safe answer is to unwind to the root and retry after the refusal window, never to
 * fail the migration toward poison and the project breaker.
 */
const FLIP_UNWINDABLE_REASONS = new Set([
  'session_not_terminal',
  'terminal_grace_not_elapsed',
  'active_acp_session',
  'active_session_state',
  'active_task_wait',
  'active_idle_cleanup',
  'unresolved_attention',
  'message_comments_present',
  'tool_payload_cleanup_incomplete',
  'terminal_version_changed',
]);

export type ArchiveSourceFlipRefusal = {
  refused: true;
  reason: string;
  message: string;
};

/**
 * `finalizeSourceDelete` for coordinators that can unwind: a late-writer disagreement comes back
 * as a value, so its reason survives the RPC boundary (rule 63) and nothing has been written.
 * A separate RPC rather than a changed return shape, so a coordinator from before this change
 * keeps calling `archiveSourceFinalizeDelete` and keeps its throwing contract during a rollout.
 */
export async function flipArchiveSource(
  sql: SqlStorage,
  input: ArchiveSourceFinalizeDeleteInput,
  transactionSync?: <T>(callback: () => T) => T
): Promise<ArchiveSourceFinalizeDeleteResult | ArchiveSourceFlipRefusal> {
  try {
    return await finalizeSourceDelete(sql, input, transactionSync, {
      proveByWriteGeneration: true,
    });
  } catch (error) {
    if (
      error instanceof ProjectDataArchiveInvariantError &&
      FLIP_UNWINDABLE_REASONS.has(error.reason)
    ) {
      return { refused: true, reason: error.reason, message: error.message };
    }
    throw error;
  }
}

export type ArchiveSourceReclaimPageInput = {
  projectId: string;
  sessionId: string;
  migrationId: string;
  /** Most rows this call deletes across all transcript tables. */
  maxRows: number;
};

export type ArchiveSourceReclaimPageResult = {
  messagesDeleted: number;
  groupedRowsDeleted: number;
  ftsRowsDeleted: number;
  toolArchiveRowsDeleted: number;
  /** True when this session still owns transcript rows in the root after this page. */
  remaining: boolean;
  /** Root database size before and after this page, for reclaimed-bytes accounting. */
  databaseSizeBeforeBytes?: number;
  databaseSizeAfterBytes?: number;
  /**
   * True when a copy-back is restoring this session: nothing was deleted, because the rows in
   * the root are being restored rather than left over.
   */
  copyBackInProgress?: boolean;
};

/**
 * Set by the first copy-back restore chunk and cleared when the copy-back is marked restored.
 * While it is present the session's root rows are being RESTORED, not left over, so reclaim
 * must not touch them. The value is the migration id, and only a fence for the session's
 * current migration counts. Kept in `do_meta` so no table migration is needed.
 */
const COPY_BACK_IN_PROGRESS_META_PREFIX = 'archive_copy_back_in_progress:';
/**
 * Set by the flip (`finalizeSourceDelete`) and cleared by the reclaim page that deletes the
 * session's last row, so listing pending reclaims costs O(pending) rather than a probe of every
 * `source_deleted` intent the root has ever recorded. Value: the migration id.
 */
const RECLAIM_PENDING_META_PREFIX = 'archive_reclaim_pending:';
/** Upper bound on one reclaim page, whatever the caller asks for, so no page holds the root long. */
const ARCHIVE_RECLAIM_MAX_PAGE_ROWS = 2_000;

const COPY_BACK_IN_PROGRESS_SQL = 'SELECT 1 AS present FROM do_meta WHERE key = ? AND value = ?';

function isCopyBackInProgress(sql: SqlStorage, sessionId: string, migrationId: string): boolean {
  return (
    sql
      .exec(COPY_BACK_IN_PROGRESS_SQL, COPY_BACK_IN_PROGRESS_META_PREFIX + sessionId, migrationId)
      .toArray().length > 0
  );
}

const SOURCE_OWNS_ROWS_SQL = `SELECT (
    EXISTS (SELECT 1 FROM chat_messages WHERE session_id = ?)
    OR EXISTS (SELECT 1 FROM chat_messages_grouped WHERE session_id = ?)
    OR EXISTS (SELECT 1 FROM tool_payload_archives WHERE session_id = ?)
  ) AS present`;

function sourceStillOwnsRows(sql: SqlStorage, sessionId: string): boolean {
  const row = sql.exec(SOURCE_OWNS_ROWS_SQL, sessionId, sessionId, sessionId).toArray()[0];
  return Number(row?.present ?? 0) === 1;
}

const LIST_RECLAIM_PENDING_SQL = `SELECT i.session_id, i.migration_id, i.source_deleted_at
  FROM do_meta pending
  JOIN project_data_archive_source_intents i
    ON i.session_id = substr(pending.key, ?)
   AND i.migration_id = pending.value
  WHERE pending.key >= ? AND pending.key < ?
    AND i.project_id = ?
    AND i.state = 'source_deleted'
    AND (? IS NULL OR i.session_id = ?)
    AND NOT EXISTS (
      SELECT 1 FROM do_meta fence
      WHERE fence.key = ? || i.session_id AND fence.value = i.migration_id
    )
  ORDER BY pending.key ASC
  LIMIT ?`;

/**
 * Sessions whose archive flip has committed (`source_deleted` intent) and whose transcript rows
 * have not all been reclaimed. Read from the marker the flip writes, so a reclaim interrupted by
 * a crash, a deadline, or an older coordinator that published without reclaiming is still
 * found. Sessions fenced by an in-progress copy-back of the same migration are left out.
 */
export function listArchiveSourceReclaimPending(
  sql: SqlStorage,
  input: { projectId: string; limit: number; sessionId?: string | null }
): Array<{ sessionId: string; migrationId: string; flippedAt: number | null }> {
  const sessionId = input.sessionId ?? null;
  return sql
    .exec(
      LIST_RECLAIM_PENDING_SQL,
      RECLAIM_PENDING_META_PREFIX.length + 1,
      RECLAIM_PENDING_META_PREFIX,
      // The smallest string greater than every key with the prefix (':' + 1 = ';').
      RECLAIM_PENDING_META_PREFIX.slice(0, -1) + ';',
      input.projectId,
      sessionId,
      sessionId,
      COPY_BACK_IN_PROGRESS_META_PREFIX,
      Math.max(1, Math.floor(input.limit))
    )
    .toArray()
    .map((row) => ({
      sessionId: strictString(row.session_id, 'source_intent.session_id'),
      migrationId: strictString(row.migration_id, 'source_intent.migration_id'),
      flippedAt: optionalInteger(row.source_deleted_at),
    }));
}

/**
 * Delete at most `maxRows` transcript rows of a session whose archive flip has committed.
 *
 * Messages go first: materialization builds grouped rows from messages, so removing messages
 * first means nothing can regenerate what a later page deletes. Grouped rows go with their FTS
 * delete markers, then tool-payload archive rows. Each call is one transaction, so a reset
 * leaves whole pages, and the next call continues from whatever is left.
 */
export function reclaimArchiveSourcePage(
  sql: SqlStorage,
  input: ArchiveSourceReclaimPageInput,
  transactionSync: <T>(callback: () => T) => T = (callback) => callback()
): ArchiveSourceReclaimPageResult {
  const intent = readSourceIntent(sql, input.sessionId);
  if (
    !intent ||
    intent.project_id !== input.projectId ||
    intent.migration_id !== input.migrationId ||
    intent.state !== 'source_deleted'
  ) {
    throw new ProjectDataArchiveInvariantError(
      'source_reclaim_not_flipped',
      'ProjectData archive source rows may be reclaimed only after this migration flipped the session'
    );
  }
  if (isCopyBackInProgress(sql, input.sessionId, input.migrationId)) {
    return {
      messagesDeleted: 0,
      groupedRowsDeleted: 0,
      ftsRowsDeleted: 0,
      toolArchiveRowsDeleted: 0,
      remaining: true,
      copyBackInProgress: true,
    };
  }
  const requested = Number.isFinite(input.maxRows) ? Math.floor(input.maxRows) : 1;
  const maxRows = Math.min(ARCHIVE_RECLAIM_MAX_PAGE_ROWS, Math.max(1, requested));
  return transactionSync(() => {
    const databaseSizeBeforeBytes = databaseSize(sql);
    let budget = maxRows;
    const messagesDeleted =
      sql.exec(
        `DELETE FROM chat_messages WHERE rowid IN (
           SELECT rowid FROM chat_messages WHERE session_id = ? LIMIT ?)`,
        input.sessionId,
        budget
      ).rowsWritten ?? 0;
    budget -= messagesDeleted;
    let groupedRowsDeleted = 0;
    let ftsRowsDeleted = 0;
    if (budget > 0) {
      const rows = sql
        .exec(
          'SELECT rowid, content FROM chat_messages_grouped WHERE session_id = ? LIMIT ?',
          input.sessionId,
          budget
        )
        .toArray();
      for (const row of rows) {
        try {
          sql.exec(
            `INSERT INTO chat_messages_grouped_fts(chat_messages_grouped_fts, rowid, content)
             VALUES('delete', ?, ?)`,
            row.rowid,
            row.content
          );
          ftsRowsDeleted++;
        } catch (error) {
          // Out of memory must roll the page back rather than delete the row and strand its
          // FTS entry; the next page retries (same policy as grouped-fts-cleanup.ts).
          if (isDurableObjectSqliteNoMemError(error)) throw error;
          log.warn('archive_source_fts_delete_marker_failed', {
            sessionId: input.sessionId,
            rowid: row.rowid,
            ...serializeError(error),
          });
        }
        groupedRowsDeleted +=
          sql.exec('DELETE FROM chat_messages_grouped WHERE rowid = ?', row.rowid).rowsWritten ?? 0;
      }
      budget -= rows.length;
    }
    let toolArchiveRowsDeleted = 0;
    if (budget > 0) {
      toolArchiveRowsDeleted =
        sql.exec(
          `DELETE FROM tool_payload_archives WHERE rowid IN (
             SELECT rowid FROM tool_payload_archives WHERE session_id = ? LIMIT ?)`,
          input.sessionId,
          budget
        ).rowsWritten ?? 0;
    }
    const remaining = sourceStillOwnsRows(sql, input.sessionId);
    const databaseSizeAfterBytes = databaseSize(sql);
    if (!remaining) {
      sql.exec('DELETE FROM do_meta WHERE key = ?', RECLAIM_PENDING_META_PREFIX + input.sessionId);
      // The reclaim evidence the flip recorded as "nothing freed yet" becomes the real
      // post-reclaim size once the last row is gone.
      sql.exec(
        `UPDATE project_data_archive_source_intents
         SET source_database_size_after = ?
         WHERE session_id = ? AND migration_id = ? AND state = 'source_deleted'`,
        databaseSizeAfterBytes,
        input.sessionId,
        input.migrationId
      );
    }
    return {
      messagesDeleted,
      groupedRowsDeleted,
      ftsRowsDeleted,
      toolArchiveRowsDeleted,
      remaining,
      databaseSizeBeforeBytes,
      databaseSizeAfterBytes,
    };
  });
}

/** True when a flipped session still has transcript rows waiting to be reclaimed. */
export function archiveSourceReclaimOutstanding(sql: SqlStorage, sessionId: string): boolean {
  return sourceStillOwnsRows(sql, sessionId);
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
  before: MessageCursor | null,
  after: MessageCursor | null,
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
  if (source && isSourceExactReadFenced(validateIntentState(source.state))) {
    throw new ProjectDataArchiveInvariantError(
      'source_migration_in_progress',
      'ProjectData archive source exact read failed closed because the session was flipped to its archive shard'
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
  if (source && isSourceExactReadFenced(validateIntentState(source.state))) {
    throw new ProjectDataArchiveInvariantError(
      'source_migration_in_progress',
      'ProjectData archive source count read failed closed because the session was flipped to its archive shard'
    );
  }
  return messages.getMessageCount(sql, input.sessionId, roles);
}

export function assertSourceExactReadAvailable(
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
  if (source && isSourceExactReadFenced(validateIntentState(source.state))) {
    throw new ProjectDataArchiveInvariantError(
      'source_migration_in_progress',
      `ProjectData archive source ${operation} failed closed because the session was flipped to its archive shard`
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

export function archiveSourceSearchMessagesWithCoverage(
  sql: SqlStorage,
  input: ProjectDataArchiveExactReadInput,
  query: string,
  roles: string[] | null,
  limit: number,
  bounds: messages.MessageSearchBounds
): messages.MessageSearchWithCoverage {
  assertSourceExactReadAvailable(sql, input, 'search read');
  return messages.searchMessagesWithCoverage(sql, query, input.sessionId, roles, limit, bounds);
}

/** Fails closed unless this object owns a sealed or published copy of the session. */
export function assertTargetExactReadAvailable(
  sql: SqlStorage,
  input: ProjectDataArchiveExactReadInput,
  operation: string
): void {
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
      `ProjectData archive target ${operation} is not sealed`
    );
  }
}

export async function archiveTargetReadMessages(
  sql: SqlStorage,
  env: Env,
  input: ProjectDataArchiveExactReadInput,
  options: compactArchive.CompactRawPageOptions & { compact: boolean }
): Promise<{ messages: Record<string, unknown>[]; hasMore: boolean }> {
  const { limit, before, after, roles, compact, order } = options;
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
  if (compactArchive.isCompactArchive(sql, input.sessionId)) {
    const rows = await compactArchive.compactRawPage(sql, env, input.sessionId, {
      ...options,
      limit: limit + 1,
    });
    return messages.formatMessageRows(rows, input.sessionId, limit, compact, order, compactOptions);
  }
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
  let inlineContent: unknown[] | null;
  if (compactArchive.isCompactArchive(sql, input.sessionId)) {
    const raw = await compactArchive.compactRawMessage(sql, env, input.sessionId, input.messageId);
    if (raw?.role !== 'tool') return null;
    try {
      const metadata = typeof raw.tool_metadata === 'string' ? JSON.parse(raw.tool_metadata) : null;
      inlineContent = Array.isArray(metadata?.content) ? metadata.content : [];
    } catch {
      inlineContent = [];
    }
  } else {
    inlineContent = messages.getMessageToolContent(sql, input.sessionId, input.messageId);
  }
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
  return compactArchive.isCompactArchive(sql, input.sessionId)
    ? compactArchive.compactMessageCount(sql, input.sessionId, roles)
    : messages.getMessageCount(sql, input.sessionId, roles);
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

function searchArchiveProjection(
  sql: SqlStorage,
  query: string,
  roles: string[] | null,
  limit: number,
  filters: { sessionId: string } | { owner: ProjectDataArchiveOwnerRef }
): ArchiveSearchResult[] {
  const ftsQuery = messages.buildFtsQuery(query);
  const conditions = [
    "t.state IN ('sealed', 'published')",
    "t.search_index_state = 'complete'",
    `t.search_index_version = ${ARCHIVE_SEARCH_INDEX_VERSION}`,
  ];
  const params: Array<string | number> = [];
  if ('sessionId' in filters) {
    conditions.push('d.session_id = ?');
    params.push(filters.sessionId);
  } else {
    conditions.push('t.project_id = ?', 't.owner_name = ?', 't.generation = ?');
    params.push(filters.owner.projectId, filters.owner.ownerName, filters.owner.generation);
  }
  if (roles && roles.length > 0) {
    conditions.push(`d.role IN (${roles.map(() => '?').join(', ')})`);
    params.push(...roles);
  }

  // The AST SQL-safety check recognizes `whereClause` as a parameterized
  // condition builder. Every caller value represented here is still bound
  // through `params`; the only literal fragment is the fixed condition list.
  const whereClause = conditions.join(' AND ');
  let rows: Record<string, unknown>[];
  if (ftsQuery) {
    rows = sql
      .exec(
        `SELECT d.document_id AS id, d.session_id, d.role, d.content, d.created_at,
                s.topic AS session_topic, s.task_id AS session_task_id
         FROM project_data_archive_search_documents d
         JOIN chat_sessions s ON s.id = d.session_id
         JOIN project_data_archive_target_sessions t ON t.session_id = d.session_id
         JOIN project_data_archive_search_documents_fts f ON f.rowid = d.rowid
         WHERE f.project_data_archive_search_documents_fts MATCH ?
           AND ${whereClause}
         ORDER BY rank
         LIMIT ?`,
        ftsQuery,
        ...params,
        limit
      )
      .toArray();
  } else {
    const likePatterns = messages.getSearchQueryLikePatterns(query);
    const likeConditions = likePatterns
      .map(() => String.raw`d.content LIKE ? ESCAPE '\'`)
      .join(' AND ');
    const querySql = [
      'SELECT d.document_id AS id, d.session_id, d.role, d.content, d.created_at,',
      '       s.topic AS session_topic, s.task_id AS session_task_id',
      'FROM project_data_archive_search_documents d',
      'JOIN chat_sessions s ON s.id = d.session_id',
      'JOIN project_data_archive_target_sessions t ON t.session_id = d.session_id',
      `WHERE ${likeConditions}`,
      `  AND ${whereClause}`,
      'ORDER BY d.created_at DESC, d.session_id ASC, d.document_id ASC',
      'LIMIT ?',
    ].join('\n');
    rows = sql.exec(querySql, ...likePatterns, ...params, limit * 2).toArray();
  }
  const deduped = new Map<string, ArchiveSearchResult>();
  for (const row of rows) {
    const result = mapArchiveSearchRow(row, query);
    const key = `${result.sessionId}\u0000${result.id}`;
    if (!deduped.has(key)) deduped.set(key, result);
  }
  return [...deduped.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
}

export async function archiveTargetSearchMessages(
  sql: SqlStorage,
  env: Env,
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
  await ensureArchiveSearchCoverage(sql, env, input.sessionId, Date.now(), {
    verifyExisting: false,
  });
  return searchArchiveProjection(sql, query, roles, limit, { sessionId: input.sessionId });
}

export type ArchiveOwnerSearchResult = {
  results: ArchiveSearchResult[];
  coverage: {
    sessionsAvailable: number;
    sessionsIndexed: number;
    sessionsIncomplete: number;
    repairAttempts: number;
    sessionsRepaired: number;
    errors: Array<{ sessionId: string; error: string }>;
  };
};

export async function archiveTargetSearchProjectMessages(
  sql: SqlStorage,
  env: Env,
  input: ProjectDataArchiveOwnerRef,
  query: string,
  roles: string[] | null,
  limit: number
): Promise<ArchiveOwnerSearchResult> {
  if (input.kind !== 'archive_shard' || input.generation <= 0) {
    throw new ProjectDataArchiveInvariantError(
      'target_owner_mismatch',
      'ProjectData archive project search must target an archive shard owner'
    );
  }
  const sessionsAvailable = countRows(
    sql,
    `SELECT COUNT(*) AS count
     FROM project_data_archive_target_sessions
     WHERE project_id = ? AND owner_name = ? AND generation = ?
       AND state IN ('sealed', 'published')`,
    input.projectId,
    input.ownerName,
    input.generation
  );
  const configuredRepairLimit = Number.parseInt(
    env?.PROJECT_DATA_ARCHIVE_SEARCH_REPAIR_SESSIONS ?? '',
    10
  );
  const repairLimit =
    Number.isSafeInteger(configuredRepairLimit) && configuredRepairLimit > 0
      ? Math.min(configuredRepairLimit, 16)
      : 1;
  const sessionsIndexedBeforeRepair = countRows(
    sql,
    `SELECT COUNT(*) AS count
     FROM project_data_archive_target_sessions
     WHERE project_id = ? AND owner_name = ? AND generation = ?
       AND state IN ('sealed', 'published')
       AND search_index_version = ? AND search_index_state = 'complete'`,
    input.projectId,
    input.ownerName,
    input.generation,
    ARCHIVE_SEARCH_INDEX_VERSION
  );
  const sessions = sql
    .exec(
      `SELECT session_id
       FROM project_data_archive_target_sessions
       WHERE project_id = ? AND owner_name = ? AND generation = ?
         AND state IN ('sealed', 'published')
         AND (search_index_version IS NULL OR search_index_version != ?
              OR search_index_state IS NULL OR search_index_state != 'complete')
       ORDER BY session_id ASC LIMIT ?`,
      input.projectId,
      input.ownerName,
      input.generation,
      ARCHIVE_SEARCH_INDEX_VERSION,
      repairLimit
    )
    .toArray();
  const coverageErrors: Array<{ sessionId: string; error: string }> = [];
  for (const row of sessions) {
    const sessionId = strictString(row.session_id, 'archive_search.session_id');
    try {
      await repairArchiveSearchProjectionStep(sql, env, sessionId, Date.now());
    } catch (error) {
      log.warn('archive_search_projection_repair_failed', {
        projectId: input.projectId,
        ownerName: input.ownerName,
        sessionId,
        ...serializeError(error),
      });
      coverageErrors.push({
        sessionId,
        error: 'archive_search_projection_repair_failed',
      });
    }
  }
  const sessionsIndexed = countRows(
    sql,
    `SELECT COUNT(*) AS count
     FROM project_data_archive_target_sessions
     WHERE project_id = ? AND owner_name = ? AND generation = ?
       AND state IN ('sealed', 'published')
       AND search_index_version = ? AND search_index_state = 'complete'`,
    input.projectId,
    input.ownerName,
    input.generation,
    ARCHIVE_SEARCH_INDEX_VERSION
  );
  return {
    results: searchArchiveProjection(sql, query, roles, limit, { owner: input }),
    coverage: {
      sessionsAvailable,
      sessionsIndexed,
      sessionsIncomplete: sessionsAvailable - sessionsIndexed,
      repairAttempts: sessions.length,
      sessionsRepaired: Math.max(0, sessionsIndexed - sessionsIndexedBeforeRepair),
      errors: coverageErrors,
    },
  };
}
