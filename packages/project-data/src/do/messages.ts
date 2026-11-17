/**
 * Message storage, retrieval, batch persistence, and sequencing. Search lives in
 * `message-search.ts`; its DO-facing entry points are re-exported here.
 */
import type { MessageCursor } from '@simple-agent-manager/shared';
import { log } from '@simple-agent-manager/worker-core';

import {
  insertNewMessage,
  nextSequence,
  resolveDuplicateMessage,
} from './messages-persist-helpers';
import {
  type CompactMessageOptions,
  parseChatMessageRow,
  parseChatMessageRowCompact,
  parseCount,
} from './row-schemas';
import { assertSessionIdentityGuard, type SessionIdentityGuard } from './sessions';
import { messageBoundsClause } from './message-cursor';
import { assertTranscriptWriteAllowed } from './transcript-write-fence';
import type { Env } from './types';
import { generateId } from './types';

export type { MessageSearchBounds, MessageSearchWithCoverage } from './message-search';
export {
  buildFtsQuery,
  extractSnippet,
  getSearchQueryLikePatterns,
  resolveMessageSearchBounds,
  searchMessagesWithCoverage,
} from './message-search';
export {
  DEFAULT_MAX_MESSAGES_PER_SESSION,
  nextSequence,
  resolveMaxMessagesPerSession,
  SessionMessageLimitExceededError,
  SESSION_MESSAGE_LIMIT_EXCEEDED,
} from './messages-persist-helpers';
export {
  boundToolMetadataForStorage,
  DEFAULT_PROJECT_DATA_TOOL_METADATA_MAX_BYTES,
  resolveCompactMessageOptions,
} from './tool-metadata-storage';

export { PROJECT_DATA_TRANSCRIPT_WRITE_FENCED, ProjectDataTranscriptWriteFencedError, assertTranscriptWriteAllowed } from './transcript-write-fence';
export { persistMessageBatch } from './message-batch';

export function persistMessage(
  sql: SqlStorage,
  env: Env,
  sessionId: string,
  role: string,
  content: string,
  toolMetadata: string | null,
  messageId?: string,
  guard?: SessionIdentityGuard | null
): {
  id: string;
  now: number;
  sequence: number;
  workspaceId: string | null;
  inserted: boolean;
  toolMetadata: string | null;
} {
  assertTranscriptWriteAllowed(sql, sessionId, 'persistMessage');
  assertSessionIdentityGuard(sql, sessionId, 'persist message', guard);
  const id = messageId ?? generateId();
  const existing = sql
    .exec(
      `SELECT id, session_id, role, content, tool_metadata, created_at, sequence
       FROM chat_messages WHERE id = ? LIMIT 1`,
      id
    )
    .toArray()[0];
  if (existing) {
    return resolveDuplicateMessage(sql, existing, id, sessionId, role, content);
  }
  return insertNewMessage(sql, env, sessionId, role, content, toolMetadata, id);
}

/**
 * Cloudflare DO RPC has a hard 32 MiB serialization ceiling.
 * We leave a 2 MiB margin for the session envelope, pagination metadata,
 * and JSON structural overhead.
 */
export const RPC_SIZE_BUDGET_BYTES = 30 * 1024 * 1024; // 30 MiB

export function estimateRowBytes(row: Record<string, unknown>): number {
  let size = 64; // object overhead + fixed fields (id, role, created_at, sequence)
  const content = row.content;
  if (typeof content === 'string') size += content.length * 2; // UTF-16 chars
  const tm = row.tool_metadata;
  if (typeof tm === 'string') size += tm.length * 2;
  return size;
}

export function getMessages(
  sql: SqlStorage,
  sessionId: string,
  limit: number = 1000,
  before: MessageCursor | null = null,
  after: MessageCursor | null = null,
  roles?: string[],
  compact: boolean = false,
  order: 'asc' | 'desc' = 'desc',
  compactOptions?: CompactMessageOptions
): { messages: Record<string, unknown>[]; hasMore: boolean; skippedMessages?: number } {
  let query =
    'SELECT id, session_id, role, content, tool_metadata, created_at, sequence, origin FROM chat_messages WHERE session_id = ?';
  const params: (string | number)[] = [sessionId];

  const bounds = messageBoundsClause({ before, after });
  query += bounds.sql;
  params.push(...bounds.values);

  if (roles && roles.length > 0) {
    const placeholders = roles.map(() => '?').join(', ');
    query += ` AND role IN (${placeholders})`;
    params.push(...roles);
  }

  const orderDirection = order === 'asc' ? 'ASC' : 'DESC';
  query += ` ORDER BY created_at ${orderDirection}, sequence ${orderDirection}, id ${orderDirection} LIMIT ?`;
  params.push(limit + 1);

  const rows = sql.exec(query, ...params).toArray();
  return formatMessageRows(rows, sessionId, limit, compact, order, compactOptions);
}

function parseListedMessage(
  row: Record<string, unknown>,
  sessionId: string,
  compact: boolean,
  compactOptions?: CompactMessageOptions
): Record<string, unknown> | null {
  try {
    return compact ? parseChatMessageRowCompact(row, compactOptions) : parseChatMessageRow(row);
  } catch (e) {
    log.warn('messages.list_row_skipped', {
      rowId: typeof row.id === 'string' ? row.id : null,
      rowSessionId: typeof row.session_id === 'string' ? row.session_id : null,
      requestedSessionId: sessionId,
      compact,
      error: String(e),
    });
  }
  return null;
}

export function formatMessageRows(
  rows: Record<string, unknown>[],
  sessionId: string,
  limit: number,
  compact: boolean,
  order: 'asc' | 'desc',
  compactOptions?: CompactMessageOptions
): { messages: Record<string, unknown>[]; hasMore: boolean; skippedMessages?: number } {
  let hasMore = rows.length > limit;
  const candidateRows = hasMore ? rows.slice(0, limit) : rows;

  // RPC size guard: walk the result set (newest-first) and stop before
  // exceeding the serialization budget. Because the query returns rows in
  // DESC order and we reverse() before returning, we trim from the END
  // of the candidate list (i.e. the oldest messages) so the caller still
  // sees the most recent messages and can paginate backwards for older ones.
  let cumulativeBytes = 0;
  let safeCount = candidateRows.length;
  for (const [i, row] of candidateRows.entries()) {
    cumulativeBytes += estimateRowBytes(row);
    if (cumulativeBytes > RPC_SIZE_BUDGET_BYTES) {
      safeCount = i; // exclude this row and everything after
      hasMore = true;
      log.warn('messages.rpc_size_guard_truncated', {
        sessionId,
        requestedLimit: limit,
        totalRows: candidateRows.length,
        truncatedTo: safeCount,
        estimatedBytes: cumulativeBytes,
      });
      break;
    }
  }

  const trimmedRows = candidateRows.slice(0, safeCount);

  const orderedRows = trimmedRows;
  if (order === 'desc') orderedRows.reverse();
  const messages: Record<string, unknown>[] = [];
  let skipped = 0;

  for (const row of orderedRows) {
    const message = parseListedMessage(row, sessionId, compact, compactOptions);
    if (message) messages.push(message);
    else skipped++;
  }

  if (skipped > 0) {
    log.warn('messages.list_degraded', {
      sessionId,
      requestedLimit: limit,
      fetched: rows.length,
      returned: messages.length,
      skipped,
      compact,
    });
  }

  return {
    messages,
    hasMore,
    ...(skipped > 0 ? { skippedMessages: skipped } : {}),
  };
}

export function getMessageCount(sql: SqlStorage, sessionId: string, roles?: string[]): number {
  let query = 'SELECT COUNT(*) as count FROM chat_messages WHERE session_id = ?';
  const params: (string | number)[] = [sessionId];

  if (roles && roles.length > 0) {
    const placeholders = roles.map(() => '?').join(', ');
    query += ` AND role IN (${placeholders})`;
    params.push(...roles);
  }

  const row = sql.exec(query, ...params).toArray()[0];
  return row ? parseCount(row, 'messages.count') : 0;
}

/**
 * Fetch the tool_metadata.content array for a single tool message.
 * Used by the lazy-load endpoint to fetch content on demand.
 */
export function getMessageToolContent(
  sql: SqlStorage,
  sessionId: string,
  messageId: string
): unknown[] | null {
  const row = sql
    .exec(
      'SELECT role, tool_metadata FROM chat_messages WHERE id = ? AND session_id = ?',
      messageId,
      sessionId
    )
    .toArray()[0];

  if (!row) return null;
  if (row.role !== 'tool') return null;

  const rawMeta = row.tool_metadata;
  if (typeof rawMeta !== 'string') return [];

  try {
    const parsed = JSON.parse(rawMeta);
    if (parsed && typeof parsed === 'object' && Array.isArray(parsed.content)) {
      return parsed.content as unknown[];
    }
    return [];
  } catch {
    return [];
  }
}

export function persistSystemMessage(
  sql: SqlStorage,
  sessionId: string,
  content: string
): { id: string; now: number; sequence: number } | null {
  try {
    assertTranscriptWriteAllowed(sql, sessionId, 'persistSystemMessage');
    const id = generateId();
    const now = Date.now();
    const sequence = nextSequence(sql, sessionId);
    sql.exec(
      `INSERT INTO chat_messages (id, session_id, role, content, tool_metadata, created_at, sequence)
       VALUES (?, ?, 'system', ?, NULL, ?, ?)`,
      id,
      sessionId,
      content,
      now,
      sequence
    );
    sql.exec(
      `UPDATE chat_sessions SET message_count = message_count + 1, updated_at = ?, last_message_sequence = ?, last_message_sequence_count = message_count + 1 WHERE id = ?`,
      now,
      sequence,
      sessionId
    );
    return { id, now, sequence };
  } catch (e) {
    log.warn('project_data.system_message_insert_failed', { sessionId, error: String(e) });
    return null;
  }
}
