/**
 * The stored messages around one message, for reading a comment in its conversation.
 *
 * A comment is anchored to a stored row, but the chat displays messages, not rows: the VM
 * agent stores one row per streamed ACP chunk (`message_extract.go`), and
 * `chatMessagesToConversationItems` (apps/web) merges consecutive `assistant` rows, and
 * consecutive `thinking` rows, into one displayed message. So the window is counted in
 * displayed messages. It always holds the whole message the anchor belongs to — the rows
 * before the anchor that continue it (an anchor can be a later chunk) and the rows after it,
 * where the quoted words are — then `messagesEachSide` messages either way.
 *
 * The run rule is deliberately the plain role rule. The client also merges across a
 * tool-call update or plan replacement between two agent rows; the server does not know
 * which tool rows are updates, so it may count such a row as a message. That only makes the
 * window count one message early on that side; the client still merges and renders exactly.
 *
 * Reads run in this object against its own SQLite (or compact archive chunks), so the extra
 * pages a long agent reply needs cost no network round trip. Each side is bounded by
 * `maxRows` rows and half the RPC size budget, and reports whether more exists.
 */
import type { MessageCursor, MessagePosition } from '@simple-agent-manager/shared';

import type { ProjectDataArchiveExactReadInput } from '../../project-data-archive/contract';
import * as archiveSharding from './archive-sharding';
import * as compactArchive from './compact-archive';
import * as messages from './messages';
import type { Env } from './types';

/** Roles whose consecutive rows the chat merges into one displayed message. */
const MERGED_ROLES: ReadonlySet<string> = new Set(['assistant', 'thinking']);

/** Rows per page read inside one side's scan; the side's own `maxRows` caps the total. */
const SCAN_PAGE_ROWS = 250;

/** Each side may use half the DO RPC size budget, so the whole window stays under it. */
const SIDE_BYTE_BUDGET = messages.RPC_SIZE_BUDGET_BYTES / 2;

export interface MessageContextRequest {
  messageId: string;
  /** Displayed messages to include each side of the anchored message. */
  messagesEachSide: number;
  /** Stored rows to read each side, at most. */
  maxRows: number;
  compact: boolean;
}

export interface MessageContextResult {
  /** False when the anchored message is no longer in the transcript. */
  found: boolean;
  /** Formatted rows (the `getMessages` shape) in transcript order. */
  messages: Record<string, unknown>[];
  hasMoreBefore: boolean;
  hasMoreAfter: boolean;
}

type Page = { messages: Record<string, unknown>[]; hasMore: boolean };

interface MessageContextReader {
  /** The formatted row for `messageId` in this session, or null. */
  locate(messageId: string): Promise<Record<string, unknown> | null>;
  /** One page inside exclusive bounds, returned in transcript order (as `getMessages` does). */
  page(
    bounds: { before: MessageCursor | null; after: MessageCursor | null },
    limit: number,
    order: 'asc' | 'desc'
  ): Promise<Page>;
}

const NOT_FOUND: MessageContextResult = {
  found: false,
  messages: [],
  hasMoreBefore: false,
  hasMoreAfter: false,
};

function rowRole(row: Record<string, unknown>): string | null {
  return typeof row.role === 'string' ? row.role : null;
}

function rowPosition(row: Record<string, unknown>): MessagePosition | null {
  const { createdAt, sequence, id } = row;
  if (typeof createdAt !== 'number' || typeof sequence !== 'number' || typeof id !== 'string') {
    return null;
  }
  return { createdAt, sequence, id };
}

/** Approximate serialized size, in the same UTF-16 terms as `estimateRowBytes`. */
function formattedRowBytes(row: Record<string, unknown>): number {
  const content = typeof row.content === 'string' ? row.content.length : 0;
  const metadata =
    row.toolMetadata === null || row.toolMetadata === undefined
      ? 0
      : JSON.stringify(row.toolMetadata).length;
  return 64 + (content + metadata) * 2;
}

/**
 * Rows on one side of the anchor, nearest first: the rest of the anchored message, then
 * `messagesEachSide` more messages, stopping at `maxRows` rows or the byte budget.
 */
async function scanSide(
  reader: MessageContextReader,
  anchor: { role: string | null; position: MessagePosition },
  side: 'before' | 'after',
  request: MessageContextRequest
): Promise<{ rows: Record<string, unknown>[]; hasMore: boolean }> {
  const rows: Record<string, unknown>[] = [];
  let bytes = 0;
  // The displayed message being read: the anchored one first. `openRole` is the role its
  // further rows would carry, or null when a message is a single row.
  let openRole = anchor.role !== null && MERGED_ROLES.has(anchor.role) ? anchor.role : null;
  let messagesRead = 0;
  let cursor = anchor.position;

  for (;;) {
    const limit = Math.min(SCAN_PAGE_ROWS, request.maxRows - rows.length);
    if (limit <= 0) return { rows, hasMore: true };
    const page = await reader.page(
      side === 'before' ? { before: cursor, after: null } : { before: null, after: cursor },
      limit,
      side === 'before' ? 'desc' : 'asc'
    );
    const nearestFirst = side === 'before' ? [...page.messages].reverse() : page.messages;
    for (const row of nearestFirst) {
      const role = rowRole(row);
      const continuesMessage = openRole !== null && role === openRole;
      if (!continuesMessage) {
        if (messagesRead >= request.messagesEachSide) return { rows, hasMore: true };
        messagesRead += 1;
        openRole = role !== null && MERGED_ROLES.has(role) ? role : null;
      }
      bytes += formattedRowBytes(row);
      if (bytes > SIDE_BYTE_BUDGET) return { rows, hasMore: true };
      rows.push(row);
    }
    if (!page.hasMore) return { rows, hasMore: false };
    const farthest = nearestFirst[nearestFirst.length - 1];
    const next = farthest ? rowPosition(farthest) : null;
    // A page of only unreadable rows (or a row without a position) cannot advance the scan.
    if (!next) return { rows, hasMore: true };
    cursor = next;
  }
}

/** The window around `request.messageId`, read through `reader`. */
export async function readMessageContextWindow(
  reader: MessageContextReader,
  request: MessageContextRequest
): Promise<MessageContextResult> {
  const anchorRow = await reader.locate(request.messageId);
  const position = anchorRow ? rowPosition(anchorRow) : null;
  if (!anchorRow || !position) return NOT_FOUND;
  const anchor = { role: rowRole(anchorRow), position };
  const [before, after] = await Promise.all([
    scanSide(reader, anchor, 'before', request),
    scanSide(reader, anchor, 'after', request),
  ]);
  return {
    found: true,
    messages: [...before.rows.reverse(), anchorRow, ...after.rows],
    hasMoreBefore: before.hasMore,
    hasMoreAfter: after.hasMore,
  };
}

function selectMessageRow(
  sql: SqlStorage,
  sessionId: string,
  messageId: string
): Record<string, unknown> | null {
  return (
    sql
      .exec(
        `SELECT id, session_id, role, content, tool_metadata, created_at, sequence, origin
         FROM chat_messages WHERE id = ? AND session_id = ? LIMIT 1`,
        messageId,
        sessionId
      )
      .toArray()[0] ?? null
  );
}

/** A raw stored row in the `getMessages` shape; null when it cannot be parsed. */
function formatRow(
  env: Env,
  raw: Record<string, unknown> | null,
  sessionId: string,
  compact: boolean
): Record<string, unknown> | null {
  if (!raw) return null;
  const compactOptions = compact ? messages.resolveCompactMessageOptions(env) : undefined;
  return (
    messages.formatMessageRows([raw], sessionId, 1, compact, 'asc', compactOptions).messages[0] ??
    null
  );
}

/** The window from the root ProjectData object, which still owns the transcript. */
export function readSourceMessageContext(
  sql: SqlStorage,
  env: Env,
  owner: ProjectDataArchiveExactReadInput,
  request: MessageContextRequest
): Promise<MessageContextResult> {
  archiveSharding.assertSourceExactReadAvailable(sql, owner, 'context read');
  return readMessageContextWindow(
    {
      locate: async (messageId) =>
        formatRow(
          env,
          selectMessageRow(sql, owner.sessionId, messageId),
          owner.sessionId,
          request.compact
        ),
      page: async (bounds, limit, order) =>
        archiveSharding.archiveSourceReadMessages(
          sql,
          env,
          owner,
          limit,
          bounds.before,
          bounds.after,
          undefined,
          request.compact,
          order
        ),
    },
    request
  );
}

/** The window from an archive shard that holds a sealed copy of the transcript. */
export function readTargetMessageContext(
  sql: SqlStorage,
  env: Env,
  owner: ProjectDataArchiveExactReadInput,
  request: MessageContextRequest
): Promise<MessageContextResult> {
  archiveSharding.assertTargetExactReadAvailable(sql, owner, 'context read');
  return readMessageContextWindow(
    {
      locate: async (messageId) => {
        const raw = compactArchive.isCompactArchive(sql, owner.sessionId)
          ? await compactArchive.compactRawMessage(sql, env, owner.sessionId, messageId)
          : selectMessageRow(sql, owner.sessionId, messageId);
        return formatRow(env, raw, owner.sessionId, request.compact);
      },
      page: (bounds, limit, order) =>
        archiveSharding.archiveTargetReadMessages(sql, env, owner, {
          limit,
          before: bounds.before,
          after: bounds.after,
          compact: request.compact,
          order,
        }),
    },
    request
  );
}
