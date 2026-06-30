/**
 * Message storage, retrieval, batch persistence, search, and sequencing.
 */
import { buildSafeFtsQuery } from '../../lib/fts5';
import { log } from '../../lib/logger';
import {
  parseChatMessageRow,
  parseChatMessageRowCompact,
  parseCount,
  parseMaxSeq,
  parseMessageCount,
  parseSearchResultRow,
  parseWorkspaceId,
  type SearchResultParsed,
} from './row-schemas';
import type { Env } from './types';
import { generateId } from './types';

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

function resolveMaxMessagesPerSession(env: Env): number {
  const parsed = Number.parseInt(env.MAX_MESSAGES_PER_SESSION || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_MESSAGES_PER_SESSION;
}

/**
 * Returns the next monotonic sequence number for a session's messages.
 */
export function nextSequence(sql: SqlStorage, sessionId: string): number {
  const row = sql
    .exec(
      'SELECT COALESCE(MAX(sequence), 0) AS max_seq FROM chat_messages WHERE session_id = ?',
      sessionId
    )
    .toArray()[0];
  return (row ? parseMaxSeq(row, 'messages.next_sequence') : 0) + 1;
}

export function persistMessage(
  sql: SqlStorage,
  env: Env,
  sessionId: string,
  role: string,
  content: string,
  toolMetadata: string | null,
  messageId?: string
): { id: string; now: number; sequence: number; workspaceId: string | null; inserted: boolean } {
  const maxMessages = resolveMaxMessagesPerSession(env);
  const countRow = sql
    .exec('SELECT message_count FROM chat_sessions WHERE id = ?', sessionId)
    .toArray()[0];

  if (!countRow) {
    throw new Error(`Session ${sessionId} not found`);
  }
  const id = messageId ?? generateId();
  const existing = sql.exec('SELECT id FROM chat_messages WHERE id = ? LIMIT 1', id).toArray()[0];
  if (existing) {
    const wsRow = sql
      .exec('SELECT workspace_id FROM chat_sessions WHERE id = ?', sessionId)
      .toArray()[0];
    const workspaceId = wsRow
      ? parseWorkspaceId(wsRow, 'messages.persist_duplicate_workspace')
      : null;
    return { id, now: Date.now(), sequence: 0, workspaceId, inserted: false };
  }

  if (parseMessageCount(countRow, 'messages.persist_count') >= maxMessages) {
    throw new SessionMessageLimitExceededError(maxMessages);
  }

  const now = Date.now();
  const sequence = nextSequence(sql, sessionId);

  sql.exec(
    `INSERT INTO chat_messages (id, session_id, role, content, tool_metadata, created_at, sequence)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    id,
    sessionId,
    role,
    content,
    toolMetadata,
    now,
    sequence
  );

  sql.exec(
    `UPDATE chat_sessions SET message_count = message_count + 1, updated_at = ? WHERE id = ?`,
    now,
    sessionId
  );

  // Auto-capture topic from first user message
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

  // Get workspace ID for activity tracking
  const wsRow = sql
    .exec('SELECT workspace_id FROM chat_sessions WHERE id = ?', sessionId)
    .toArray()[0];
  const workspaceId = wsRow ? parseWorkspaceId(wsRow, 'messages.persist_workspace') : null;

  return { id, now, sequence, workspaceId, inserted: true };
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
  }>
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
  }>;
  workspaceId: string | null;
  firstUserContent: string | null;
  hadTopic: boolean;
  limitReached: boolean;
  maxMessages: number;
  remainingCapacity: number;
} {
  const session = sql
    .exec('SELECT id, message_count, topic, status FROM chat_sessions WHERE id = ?', sessionId)
    .toArray()[0];

  if (!session) {
    throw new Error(`Session ${sessionId} not found`);
  }

  if (session.status === 'stopped') {
    throw new Error(`Session ${sessionId} is stopped and cannot accept messages`);
  }

  const maxMessages = resolveMaxMessagesPerSession(env);
  const startingCount = parseMessageCount(session, 'messages.batch_count');
  let persisted = 0;
  let duplicates = 0;
  let limitReached = false;
  const now = Date.now();
  let nextSeq = nextSequence(sql, sessionId);
  const persistedMessages: Array<{
    id: string;
    role: string;
    content: string;
    toolMetadata: unknown;
    createdAt: number;
    sequence: number;
  }> = [];

  // Track user message content seen within this batch to avoid redundant
  // DB queries when the same user content appears multiple times in one batch.
  const seenUserContent = new Set<string>();

  for (const msg of messages) {
    const existing = sql
      .exec('SELECT id FROM chat_messages WHERE id = ?', msg.messageId)
      .toArray()[0];

    if (existing) {
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
    if (msg.role === 'user') {
      if (seenUserContent.has(msg.content)) {
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

    const createdAt = new Date(msg.timestamp).getTime() || now;
    const sequence = msg.sequence ?? nextSeq++;
    sql.exec(
      `INSERT INTO chat_messages (id, session_id, role, content, tool_metadata, created_at, sequence)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      msg.messageId,
      sessionId,
      msg.role,
      msg.content,
      msg.toolMetadata,
      createdAt,
      sequence
    );
    persisted++;
    persistedMessages.push({
      id: msg.messageId,
      role: msg.role,
      content: msg.content,
      toolMetadata: msg.toolMetadata ? JSON.parse(msg.toolMetadata) : null,
      createdAt,
      sequence,
    });
  }

  let workspaceId: string | null = null;
  let firstUserContent: string | null = null;
  const hadTopic = !!session.topic;

  if (persisted > 0) {
    sql.exec(
      `UPDATE chat_sessions SET message_count = message_count + ?, updated_at = ? WHERE id = ?`,
      persisted,
      now,
      sessionId
    );

    if (!session.topic) {
      const firstUserMsg = messages.find((m) => m.role === 'user');
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
  };
}

/**
 * Cloudflare DO RPC has a hard 32 MiB serialization ceiling.
 * We leave a 2 MiB margin for the session envelope, pagination metadata,
 * and JSON structural overhead.
 */
const RPC_SIZE_BUDGET_BYTES = 30 * 1024 * 1024; // 30 MiB

function estimateRowBytes(row: Record<string, unknown>): number {
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
  before: number | null = null,
  roles?: string[],
  compact: boolean = false,
  order: 'asc' | 'desc' = 'desc'
): { messages: Record<string, unknown>[]; hasMore: boolean } {
  let query =
    'SELECT id, session_id, role, content, tool_metadata, created_at, sequence FROM chat_messages WHERE session_id = ?';
  const params: (string | number)[] = [sessionId];

  if (before !== null) {
    query += ' AND created_at < ?';
    params.push(before);
  }

  if (roles && roles.length > 0) {
    const placeholders = roles.map(() => '?').join(', ');
    query += ` AND role IN (${placeholders})`;
    params.push(...roles);
  }

  const orderDirection = order === 'asc' ? 'ASC' : 'DESC';
  query += ` ORDER BY created_at ${orderDirection}, sequence ${orderDirection} LIMIT ?`;
  params.push(limit + 1);

  const rows = sql.exec(query, ...params).toArray();
  let hasMore = rows.length > limit;
  const candidateRows = hasMore ? rows.slice(0, limit) : rows;

  // RPC size guard: walk the result set (newest-first) and stop before
  // exceeding the serialization budget. Because the query returns rows in
  // DESC order and we reverse() before returning, we trim from the END
  // of the candidate list (i.e. the oldest messages) so the caller still
  // sees the most recent messages and can paginate backwards for older ones.
  let cumulativeBytes = 0;
  let safeCount = candidateRows.length;
  for (let i = 0; i < candidateRows.length; i++) {
    const row = candidateRows[i]!;
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

  const rowParser = compact ? parseChatMessageRowCompact : parseChatMessageRow;
  const orderedRows = order === 'desc' ? trimmedRows.reverse() : trimmedRows;
  return {
    messages: orderedRows.map((row) => rowParser(row)),
    hasMore,
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

type SearchResult = {
  id: string;
  sessionId: string;
  role: string;
  snippet: string;
  createdAt: number;
  sessionTopic: string | null;
  sessionTaskId: string | null;
};

export function searchMessages(
  sql: SqlStorage,
  query: string,
  sessionId: string | null = null,
  roles: string[] | null = null,
  limit: number = 10
): SearchResult[] {
  const results: SearchResult[] = [];

  results.push(...searchMessagesFts(sql, query, sessionId, roles, limit));

  if (results.length < limit) {
    const fallbackResults = searchMessagesLike(
      sql,
      query,
      sessionId,
      roles,
      limit - results.length,
      true
    );
    results.push(...fallbackResults);
  }

  results.sort((a, b) => b.createdAt - a.createdAt);
  return results.slice(0, limit);
}

function mapSearchResultToSearchResult(parsed: SearchResultParsed, query: string): SearchResult {
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

function searchMessagesFts(
  sql: SqlStorage,
  query: string,
  sessionId: string | null,
  roles: string[] | null,
  limit: number
): SearchResult[] {
  const ftsQuery = buildFtsQuery(query);
  if (!ftsQuery) return [];

  const conditions: string[] = ['f.chat_messages_grouped_fts MATCH ?'];
  const params: (string | number)[] = [ftsQuery];

  if (sessionId) {
    conditions.push('m.session_id = ?');
    params.push(sessionId);
  }

  if (roles && roles.length > 0) {
    const placeholders = roles.map(() => '?').join(', ');
    conditions.push(`m.role IN (${placeholders})`);
    params.push(...roles);
  }

  const whereClause = conditions.join(' AND ');
  const sqlQuery = `
    SELECT m.id, m.session_id, m.role, m.content, m.created_at,
           s.topic AS session_topic, s.task_id AS session_task_id
    FROM chat_messages_grouped_fts f
    JOIN chat_messages_grouped m ON m.rowid = f.rowid
    JOIN chat_sessions s ON s.id = m.session_id
    WHERE ${whereClause}
    ORDER BY rank
    LIMIT ?
  `;
  params.push(limit);

  try {
    const rows = sql.exec(sqlQuery, ...params).toArray();
    return rows.map((row) => mapSearchResultToSearchResult(parseSearchResultRow(row), query));
  } catch (e) {
    log.error('messages.fts5_search_failed', { error: String(e) });
    return [];
  }
}

function searchMessagesLike(
  sql: SqlStorage,
  query: string,
  sessionId: string | null,
  roles: string[] | null,
  limit: number,
  onlyNonMaterialized: boolean = false
): SearchResult[] {
  const escapedQuery = query.replace(/[%_\\]/g, '\\$&');
  const conditions: string[] = ["m.content LIKE ? ESCAPE '\\'"];
  const params: (string | number)[] = [`%${escapedQuery}%`];

  if (sessionId) {
    conditions.push('m.session_id = ?');
    params.push(sessionId);
  }

  if (roles && roles.length > 0) {
    const placeholders = roles.map(() => '?').join(', ');
    conditions.push(`m.role IN (${placeholders})`);
    params.push(...roles);
  }

  if (onlyNonMaterialized) {
    conditions.push('s.materialized_at IS NULL');
  }

  const whereClause = conditions.join(' AND ');
  const sqlQuery = `
    SELECT m.id, m.session_id, m.role, m.content, m.created_at,
           s.topic AS session_topic, s.task_id AS session_task_id
    FROM chat_messages m
    JOIN chat_sessions s ON s.id = m.session_id
    WHERE ${whereClause}
    ORDER BY m.created_at DESC
    LIMIT ?
  `;
  params.push(limit);

  const rows = sql.exec(sqlQuery, ...params).toArray();

  return rows.map((row) => mapSearchResultToSearchResult(parseSearchResultRow(row), query));
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
      `UPDATE chat_sessions SET message_count = message_count + 1, updated_at = ? WHERE id = ?`,
      now,
      sessionId
    );
    return { id, now, sequence };
  } catch (e) {
    log.warn('project_data.system_message_insert_failed', { sessionId, error: String(e) });
    return null;
  }
}
