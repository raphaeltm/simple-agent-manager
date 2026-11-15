/**
 * Private helpers for `persistMessage` (messages.ts).
 *
 * Kept in their own module so messages.ts stays under the 800-line file size
 * limit while preserving the cognitive-complexity reduction achieved by
 * splitting the original single persistMessage body. This module is
 * self-contained (no import from messages.ts) so the dependency graph stays
 * acyclic: messages.ts imports from this file, never the reverse.
 */
import { log } from '@simple-agent-manager/worker-core';

import { readMessageIngestState } from './message-stream-ingest';
import { parseMaxSeq, parseMessageCount, parseWorkspaceId } from './row-schemas';
import { boundToolMetadataForStorage } from './tool-metadata-storage';
import type { Env } from './types';

export const DEFAULT_MAX_MESSAGES_PER_SESSION = 100000;

export const SESSION_MESSAGE_LIMIT_EXCEEDED = 'SESSION_MESSAGE_LIMIT_EXCEEDED';

export class SessionMessageLimitExceededError extends Error {
  readonly code = SESSION_MESSAGE_LIMIT_EXCEEDED;
  readonly maxMessages: number;

  constructor(maxMessages: number) {
    super(`Session message limit of ${maxMessages} messages exceeded`);
    this.name = 'SessionMessageLimitExceededError';
    this.maxMessages = maxMessages;
  }
}

/**
 * Returns the next monotonic sequence number for a session's messages.
 */
export function nextSequence(
  sql: SqlStorage,
  sessionId: string,
  session?: Record<string, unknown>
): number {
  const current =
    session ??
    sql
      .exec(
        'SELECT last_message_sequence, last_message_sequence_count, message_count, stream_ingest_state FROM chat_sessions WHERE id = ?',
        sessionId
      )
      .toArray()[0];
  if (!current) throw new Error(`Session ${sessionId} not found`);
  // This tag tracks the persisted counter version, not the live logical count.
  // Deferred bookkeeping must leave count/tag unchanged together; a flush writes
  // both together. Older builds only change count, forcing one recovery scan.
  const stored = current.last_message_sequence;
  if (stored != null && current.last_message_sequence_count === current.message_count) {
    const maximum = parseMaxSeq({ max_seq: stored }, 'messages.sequence_watermark');
    const stream = readMessageIngestState(current.stream_ingest_state);
    return Math.max(maximum, stream?.maxSequence ?? 0) + 1;
  }
  const row = sql
    .exec(
      'SELECT COALESCE(MAX(sequence), 0) AS max_seq FROM chat_messages WHERE session_id = ?',
      sessionId
    )
    .toArray()[0];
  // Absorbed chunks reserve logical positions beyond the last physical row.
  const state = readMessageIngestState(current.stream_ingest_state);
  const maximum = Math.max(
    typeof stored === 'number' ? stored : 0,
    row ? parseMaxSeq(row, 'messages.next_sequence') : 0,
    state?.maxSequence ?? 0
  );
  sql.exec(
    'UPDATE chat_sessions SET last_message_sequence = ?, last_message_sequence_count = message_count WHERE id = ?',
    maximum,
    sessionId
  );
  return maximum + 1;
}

/** Archive imports preserve canonical positions; never lower a known watermark.
 * NULL is left unknown so the first live writer measures the complete restored transcript.
 * Called synchronously after each imported chunk, before any subsequent await.
 */
export function advanceImportedMessageSequence(
  sql: SqlStorage,
  sessionId: string,
  rows: readonly Record<string, unknown>[]
): void {
  const maximum = rows.reduce(
    (max, row) => Math.max(max, parseMaxSeq({ max_seq: row.sequence }, 'messages.import_sequence')),
    0
  );
  sql.exec(
    `UPDATE chat_sessions SET last_message_sequence = MAX(last_message_sequence, ?)
    WHERE id = ? AND last_message_sequence IS NOT NULL AND last_message_sequence < ?`,
    maximum,
    sessionId,
    maximum
  );
}

export function resolveMaxMessagesPerSession(env: Env): number {
  const parsed = Number.parseInt(env.MAX_MESSAGES_PER_SESSION || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_MESSAGES_PER_SESSION;
}

export interface PersistedMessageResult {
  id: string;
  now: number;
  sequence: number;
  workspaceId: string | null;
  inserted: boolean;
  toolMetadata: string | null;
}

export function resolveDuplicateMessage(
  sql: SqlStorage,
  existing: Record<string, unknown>,
  id: string,
  sessionId: string,
  role: string,
  content: string
): PersistedMessageResult {
  const createdAt = existing.created_at;
  const sequence = existing.sequence;
  if (
    existing.session_id !== sessionId ||
    existing.role !== role ||
    existing.content !== content ||
    typeof createdAt !== 'number' ||
    typeof sequence !== 'number'
  ) {
    throw new Error(`Message id ${id} already belongs to a different transcript entry`);
  }
  const wsRow = sql
    .exec('SELECT workspace_id FROM chat_sessions WHERE id = ?', sessionId)
    .toArray()[0];
  return {
    id,
    now: createdAt,
    sequence,
    workspaceId: wsRow ? parseWorkspaceId(wsRow, 'messages.persist_duplicate_workspace') : null,
    inserted: false,
    toolMetadata: typeof existing.tool_metadata === 'string' ? existing.tool_metadata : null,
  };
}

export function insertNewMessage(
  sql: SqlStorage,
  env: Env,
  sessionId: string,
  role: string,
  content: string,
  toolMetadata: string | null,
  id: string
): PersistedMessageResult {
  const countRow = sql
    .exec('SELECT message_count FROM chat_sessions WHERE id = ?', sessionId)
    .toArray()[0];
  if (!countRow) {
    throw new Error(`Session ${sessionId} not found`);
  }
  const maxMessages = resolveMaxMessagesPerSession(env);
  if (parseMessageCount(countRow, 'messages.persist_count') >= maxMessages) {
    throw new SessionMessageLimitExceededError(maxMessages);
  }

  const now = Date.now();
  const sequence = nextSequence(sql, sessionId);
  const boundedToolMetadata = boundToolMetadataForStorage(toolMetadata, env);
  if (boundedToolMetadata.truncated) {
    log.warn('messages.tool_metadata_truncated_for_storage', {
      sessionId,
      messageId: id,
      originalBytes: boundedToolMetadata.originalBytes,
      storedBytes: boundedToolMetadata.storedBytes,
    });
  }
  sql.exec(
    `INSERT INTO chat_messages (id, session_id, role, content, tool_metadata, created_at, sequence)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    id,
    sessionId,
    role,
    content,
    boundedToolMetadata.value,
    now,
    sequence
  );
  sql.exec(
    `UPDATE chat_sessions SET message_count = message_count + 1, updated_at = ?, last_message_sequence = ?, last_message_sequence_count = message_count + 1 WHERE id = ?`,
    now,
    sequence,
    sessionId
  );

  if (role === 'user') {
    const session = sql
      .exec('SELECT topic FROM chat_sessions WHERE id = ?', sessionId)
      .toArray()[0];
    if (session && !session.topic) {
      const truncatedTopic = content.length > 100 ? content.substring(0, 97) + '...' : content;
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
  return {
    id,
    now,
    sequence,
    workspaceId: wsRow ? parseWorkspaceId(wsRow, 'messages.persist_workspace') : null,
    inserted: true,
    toolMetadata: boundedToolMetadata.value,
  };
}
