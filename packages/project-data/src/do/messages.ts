/**
 * Message storage, retrieval, batch persistence, and sequencing. Search lives in
 * `message-search.ts`; its DO-facing entry points are re-exported here.
 */
import type { MessageCursor } from '@simple-agent-manager/shared';
import { log } from '@simple-agent-manager/worker-core';

import {
  PROJECT_DATA_ARCHIVE_SOURCE_INTENT_STATES,
  type ProjectDataArchiveSourceIntentState,
} from '../archive/contract';
import { DEFAULT_SESSION_IDLE_TIMEOUT_MINUTES } from '@simple-agent-manager/shared';
import { parsePositiveInt } from '@simple-agent-manager/worker-core';

import {
  flushMessageBookkeeping,
  messageBookkeepingInterval,
  BOOKKEEPING_AWAITING_SUMMARY,
} from './message-bookkeeping';
import { messageBoundsClause } from './message-cursor';
import {
  type MessageIngestSource,
  type MessageMergeConfig,
  MessageStreamBatch,
  readMessageIngestState,
} from './message-stream-ingest';
import {
  insertNewMessage,
  nextSequence,
  resolveDuplicateMessage,
  resolveMaxMessagesPerSession,
  SessionMessageLimitExceededError,
} from './messages-persist-helpers';
import {
  type CompactMessageOptions,
  parseChatMessageRow,
  parseChatMessageRowCompact,
  parseCount,
  parseMessageCount,
  parseWorkspaceId,
} from './row-schemas';
import { markRuntimeReported, withoutSamNotice } from './sam-notice-metadata';
import { assertSessionIdentityGuard, type SessionIdentityGuard } from './sessions';
import { boundToolMetadataForStorage } from './tool-metadata-storage';
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
  SESSION_MESSAGE_LIMIT_EXCEEDED,
  SessionMessageLimitExceededError,
} from './messages-persist-helpers';
export {
  boundToolMetadataForStorage,
  DEFAULT_PROJECT_DATA_TOOL_METADATA_MAX_BYTES,
  resolveCompactMessageOptions,
} from './tool-metadata-storage';

export const PROJECT_DATA_TRANSCRIPT_WRITE_FENCED = 'PROJECT_DATA_TRANSCRIPT_WRITE_FENCED';

export class ProjectDataTranscriptWriteFencedError extends Error {
  readonly code = PROJECT_DATA_TRANSCRIPT_WRITE_FENCED;

  constructor(
    readonly sessionId: string,
    readonly operation: string,
    readonly archiveState: ProjectDataArchiveSourceIntentState
  ) {
    super(
      `ProjectData transcript write ${operation} for session ${sessionId} is fenced by archive source intent ${archiveState}`
    );
    this.name = 'ProjectDataTranscriptWriteFencedError';
  }
}

function parseArchiveSourceIntentState(value: unknown): ProjectDataArchiveSourceIntentState | null {
  return typeof value === 'string' &&
    PROJECT_DATA_ARCHIVE_SOURCE_INTENT_STATES.includes(value as ProjectDataArchiveSourceIntentState)
    ? (value as ProjectDataArchiveSourceIntentState)
    : null;
}

function assertTranscriptWriteAllowed(sql: SqlStorage, sessionId: string, operation: string): void {
  let row: Record<string, unknown> | undefined;
  try {
    row = sql
      .exec(
        `SELECT state
         FROM project_data_archive_source_intents
         WHERE session_id = ?
           AND state != 'rehome_exported'
         LIMIT 1`,
        sessionId
      )
      .toArray()[0];
  } catch (error) {
    if (error instanceof Error && /no such table/i.test(error.message)) return;
    throw error;
  }
  const state = parseArchiveSourceIntentState(row?.state);
  if (state) throw new ProjectDataTranscriptWriteFencedError(sessionId, operation, state);
}

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

export function persistMessageBatch(
  sql: SqlStorage,
  env: Env,
  sessionId: string,
  messages: Array<{
    messageId: string;
    role: string;
    content: string;
    toolMetadata: string | null;
    timestamp: string;
    sequence?: number;
    origin?: string | null;
  }>,
  context?: { source?: MessageIngestSource; config: MessageMergeConfig }
): {
  persisted: number;
  duplicates: number;
  persistedMessages: Array<{
    id: string;
    role: string;
    content: string;
    toolMetadata: unknown;
    createdAt: number;
    sequence: number;
    origin: string | null;
  }>;
  workspaceId: string | null;
  firstUserContent: string | null;
  hadTopic: boolean;
  limitReached: boolean;
  maxMessages: number;
  remainingCapacity: number;
  broadcastMessages: Array<import('./message-stream-ingest').StoredBatchMessage>;
  bookkeepingScheduled: boolean;
  bookkeepingFlushed: boolean;
  appends: Array<import('@simple-agent-manager/shared').ChatMessageAppend>;
} {
  assertTranscriptWriteAllowed(sql, sessionId, 'persistMessageBatch');
  const session = sql
    .exec(
      `SELECT id, workspace_id, message_count, topic, status, pending_message_count, message_bookkeeping_due_at, last_message_sequence, last_message_sequence_count, stream_ingest_state,
      materialized_at, materialized_through_created_at, materialized_through_sequence,
      (SELECT prompt_epoch FROM session_state WHERE session_id = chat_sessions.id) AS prompt_epoch
      FROM chat_sessions WHERE id = ?`,
      sessionId
    )
    .toArray()[0];

  if (!session) {
    throw new Error(`Session ${sessionId} not found`);
  }

  if (session.status === 'stopped') {
    throw new Error(`Session ${sessionId} is stopped and cannot accept messages`);
  }

  const previousStream = readMessageIngestState(session.stream_ingest_state);
  if (context?.source && (context.config.enabled || previousStream))
    assertSessionIdentityGuard(sql, sessionId, 'persist message batch', {
      workspaceId: context.source.workspaceId,
    });
  const latest =
    previousStream?.open || (context?.config.enabled && context.source?.outboxIncarnation)
      ? sql
          .exec(
            'SELECT id, created_at, sequence FROM chat_messages WHERE session_id = ? ORDER BY created_at DESC, sequence DESC, id DESC LIMIT 1',
            sessionId
          )
          .toArray()[0]
      : null;
  const stream =
    context && (previousStream || (context.config.enabled && context.source?.outboxIncarnation))
      ? new MessageStreamBatch(
          sessionId,
          context.config,
          previousStream,
          context.source,
          messages.map((message) => message.sequence),
          typeof session.prompt_epoch === 'number' ? session.prompt_epoch : null,
          typeof latest?.id === 'string'
            ? {
                id: latest.id,
                createdAt: Number(latest.created_at),
                sequence: Number(latest.sequence),
              }
            : null,
          typeof session.materialized_through_created_at === 'number'
            ? {
                createdAt: session.materialized_through_created_at,
                sequence: Number(session.materialized_through_sequence ?? 0),
              }
            : typeof session.materialized_at === 'number'
              ? {
                  createdAt: session.materialized_at,
                  sequence: Number.MAX_SAFE_INTEGER,
                }
              : null,
          messages.map((message) => message.messageId),
          parseMessageCount(session, 'messages.batch_stream_count') +
            Number(session.pending_message_count ?? 0)
        )
      : null;

  const maxMessages = resolveMaxMessagesPerSession(env);
  const startingCount =
    parseMessageCount(session, 'messages.batch_count') + Number(session.pending_message_count ?? 0);
  let persisted = 0;
  let duplicates = 0;
  let limitReached = false;
  const now = Date.now();
  let nextSeq = nextSequence(sql, sessionId, session);
  let maximumSequence = nextSeq - 1;
  const persistedMessages: Array<{
    id: string;
    role: string;
    content: string;
    toolMetadata: unknown;
    createdAt: number;
    sequence: number;
    origin: string | null;
  }> = [];

  // Track user message content seen within this batch to avoid redundant
  // DB queries when the same user content appears multiple times in one batch.
  const seenUserContent = new Set<string>();

  for (const msg of messages) {
    const origin = msg.origin ?? null;
    if (stream?.isDuplicate(msg.messageId, msg.sequence)) {
      stream.consume(msg.messageId, msg.sequence);
      duplicates++;
      continue;
    }
    stream?.boundary(msg.role, msg.toolMetadata);
    const existing = sql
      .exec('SELECT id FROM chat_messages WHERE id = ?', msg.messageId)
      .toArray()[0];

    if (existing) {
      stream?.consume(msg.messageId, msg.sequence);
      duplicates++;
      continue;
    }

    // Content-based dedup for user messages: the same user message may arrive
    // via both the DO WebSocket (message.send → persistMessage) and the VM
    // agent batch (ExtractMessages generates a new UUID). The ID-based check
    // above misses this because the two paths use different IDs for the same
    // content. Skip batch user messages whose content is already persisted.
    //
    // Ordering guarantee: persistMessage (WebSocket path) always runs before
    // persistMessageBatch (VM agent batch path) because the WebSocket handler
    // persists synchronously on receipt, while the batch arrives after the VM
    // agent processes the prompt, extracts messages, and flushes (~2-5s later).
    if (msg.role === 'user' && origin !== 'system') {
      if (seenUserContent.has(msg.content)) {
        stream?.consume(msg.messageId, msg.sequence);
        duplicates++;
        continue;
      }
      const contentDup = sql
        .exec(
          'SELECT id FROM chat_messages WHERE session_id = ? AND role = ? AND content = ? LIMIT 1',
          sessionId,
          msg.role,
          msg.content
        )
        .toArray()[0];
      if (contentDup) {
        stream?.consume(msg.messageId, msg.sequence);
        duplicates++;
        continue;
      }
      seenUserContent.add(msg.content);
    }

    const currentCount = startingCount + persisted;
    if (currentCount >= maxMessages) {
      limitReached = true;
      break;
    }

    // Rows without a usable timestamp share `now`; reads page on (created_at, sequence, id),
    // so ties are safe (see message-cursor.ts).
    const createdAt = new Date(msg.timestamp).getTime() || now;
    // Preserve reporter positions and the established within-batch allocator.
    // The watermark caches the maximum, independently of the next fallback position.
    const sequence = msg.sequence ?? nextSeq++;
    maximumSequence = Math.max(maximumSequence, sequence);
    const boundedToolMetadata = boundToolMetadataForStorage(
      withoutSamNotice(msg.toolMetadata, sessionId, msg.messageId),
      env
    );
    if (boundedToolMetadata.truncated) {
      log.warn('messages.batch_tool_metadata_truncated_for_storage', {
        sessionId,
        messageId: msg.messageId,
        originalBytes: boundedToolMetadata.originalBytes,
        storedBytes: boundedToolMetadata.storedBytes,
      });
    }
    const storedToolMetadata =
      msg.role === 'system'
        ? markRuntimeReported(boundedToolMetadata.value)
        : boundedToolMetadata.value;
    let canonicalId = msg.messageId;
    if (stream) {
      canonicalId = stream.stage(
        {
          id: msg.messageId,
          role: msg.role,
          content: msg.content,
          toolMetadata: storedToolMetadata ? JSON.parse(storedToolMetadata) : null,
          createdAt,
          sequence,
          origin,
        },
        msg.sequence,
        storedToolMetadata
      );
      stream.consume(msg.messageId, msg.sequence);
    } else
      sql.exec(
        `INSERT INTO chat_messages (id, session_id, role, content, tool_metadata, created_at, sequence, origin)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        msg.messageId,
        sessionId,
        msg.role,
        msg.content,
        storedToolMetadata,
        createdAt,
        sequence,
        origin
      );
    persisted++;
    persistedMessages.push({
      id: canonicalId,
      role: msg.role,
      content: msg.content,
      toolMetadata: storedToolMetadata ? JSON.parse(storedToolMetadata) : null,
      createdAt,
      sequence,
      origin,
    });
  }

  let workspaceId: string | null = null;
  let firstUserContent: string | null = null;
  const hadTopic = !!session.topic;
  const staged = stream?.flush(sql);
  let bookkeepingScheduled = false;
  let bookkeepingFlushed = false;

  if (persisted > 0) {
    const firstPending =
      session.message_bookkeeping_due_at == null ||
      session.message_bookkeeping_due_at === BOOKKEEPING_AWAITING_SUMMARY;
    const interval = messageBookkeepingInterval(env, context?.config.bookkeepingIntervalMs);
    const latestAt = persistedMessages.reduce(
      (latest, message) => Math.max(latest, message.createdAt),
      0
    );
    const idleAfter =
      now +
      parsePositiveInt(env.SESSION_IDLE_TIMEOUT_MINUTES, DEFAULT_SESSION_IDLE_TIMEOUT_MINUTES) *
        60_000;
    if (firstPending) {
      sql.exec(
        `UPDATE chat_sessions SET pending_message_count = pending_message_count + ?,
           message_ingested_at = ?, message_activity_at = ?, message_idle_after = ?,
           stream_ingest_state = ?, last_message_sequence = ?,
           last_message_sequence_count = message_count, message_bookkeeping_due_at = ? WHERE id = ?`,
        persisted,
        now,
        latestAt,
        idleAfter,
        staged?.state ?? session.stream_ingest_state ?? null,
        maximumSequence,
        now + interval,
        sessionId
      );
      bookkeepingScheduled = true;
    } else {
      // Omit the indexed deadline AND indexed canonical metadata entirely on the hot path.
      sql.exec(
        `UPDATE chat_sessions SET pending_message_count = pending_message_count + ?,
           message_ingested_at = ?, message_activity_at = ?, message_idle_after = ?,
           stream_ingest_state = ?, last_message_sequence = ?,
           last_message_sequence_count = message_count WHERE id = ?`,
        persisted,
        now,
        latestAt,
        idleAfter,
        staged?.state ?? session.stream_ingest_state ?? null,
        maximumSequence,
        sessionId
      );
    }
    if (stream?.sealed) bookkeepingFlushed = flushMessageBookkeeping(sql, sessionId);

    if (!session.topic) {
      const firstUserMsg = messages.find(
        (m) => m.role === 'user' && (m.origin ?? null) !== 'system'
      );
      if (firstUserMsg) {
        firstUserContent = firstUserMsg.content;
        const truncatedTopic =
          firstUserMsg.content.length > 100
            ? firstUserMsg.content.substring(0, 97) + '...'
            : firstUserMsg.content;
        sql.exec(
          'UPDATE chat_sessions SET topic = ?, updated_at = ? WHERE id = ?',
          truncatedTopic,
          now,
          sessionId
        );
      }
    }

    const wsRow = sql
      .exec('SELECT workspace_id FROM chat_sessions WHERE id = ?', sessionId)
      .toArray()[0];
    workspaceId = wsRow ? parseWorkspaceId(wsRow, 'messages.batch_workspace') : null;
  } else if (staged && staged.state !== session.stream_ingest_state) {
    sql.exec(
      'UPDATE chat_sessions SET stream_ingest_state = ? WHERE id = ?',
      staged.state,
      sessionId
    );
  }

  const remainingCapacity = Math.max(0, maxMessages - startingCount - persisted);
  if (limitReached && persisted === 0 && duplicates === 0 && messages.length > 0) {
    throw new SessionMessageLimitExceededError(maxMessages);
  }

  return {
    persisted,
    duplicates,
    persistedMessages,
    workspaceId,
    firstUserContent,
    hadTopic,
    limitReached,
    maxMessages,
    remainingCapacity,
    bookkeepingScheduled,
    bookkeepingFlushed,
    broadcastMessages: staged?.broadcastMessages ?? persistedMessages,
    appends: staged?.appends ?? [],
  };
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
    flushMessageBookkeeping(sql, sessionId);
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
