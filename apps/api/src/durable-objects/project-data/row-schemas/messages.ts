import * as v from 'valibot';

import { expectJsonRecord } from '../../../lib/runtime-validation';
import { parseRow, safeParseJson } from './core';

// =============================================================================
// Chat message row schemas
// =============================================================================

/** Full chat message row from SELECT queries */
const ChatMessageRowSchema = v.object({
  id: v.string(),
  session_id: v.string(),
  role: v.string(),
  content: v.string(),
  tool_metadata: v.nullable(v.string()),
  created_at: v.number(),
  sequence: v.nullable(v.number()),
});

export function parseChatMessageRow(row: unknown): {
  id: string;
  sessionId: string;
  role: string;
  content: string;
  toolMetadata: unknown;
  createdAt: number;
  sequence: number | null;
} {
  const r = parseRow(ChatMessageRowSchema, row, 'chat_message');
  return {
    id: r.id,
    sessionId: r.session_id,
    role: r.role,
    content: r.content,
    toolMetadata: safeParseJson(r.tool_metadata),
    createdAt: r.created_at,
    sequence: r.sequence,
  };
}

/**
 * Parse a chat message row in compact mode: strips the `content` array from
 * tool_metadata and replaces it with a `contentSize` byte count.
 * This dramatically reduces RPC payload size for tool-heavy sessions.
 */
export function parseChatMessageRowCompact(row: unknown): {
  id: string;
  sessionId: string;
  role: string;
  content: string;
  toolMetadata: unknown;
  createdAt: number;
  sequence: number | null;
} {
  const r = parseRow(ChatMessageRowSchema, row, 'chat_message');
  const parsed = safeParseJson(r.tool_metadata);
  const toolMetadata = parsed !== null ? stripToolMetadataContent(parsed) : null;
  return {
    id: r.id,
    sessionId: r.session_id,
    role: r.role,
    content: r.content,
    toolMetadata,
    createdAt: r.created_at,
    sequence: r.sequence,
  };
}

/**
 * Strip the heavy `content` array from parsed tool_metadata, replacing it
 * with a `contentSize` field indicating the byte count of the stripped content.
 * Preserves all other metadata fields (toolCallId, title, kind, status, locations).
 */
const textEncoder = new TextEncoder();

export function stripToolMetadataContent(meta: unknown): unknown {
  if (!meta || typeof meta !== 'object') return meta;
  const obj = expectJsonRecord(meta, 'project-data.tool_metadata');
  const contentArray = obj.content;
  if (!Array.isArray(contentArray) || contentArray.length === 0) return meta;

  const contentJson = JSON.stringify(contentArray);
  const contentSize = textEncoder.encode(contentJson).byteLength;

  const rest = Object.fromEntries(Object.entries(obj).filter(([k]) => k !== 'content'));
  return { ...rest, contentSize };
}

/** Search result row (message + session join) */
const SearchResultRowSchema = v.object({
  id: v.string(),
  session_id: v.string(),
  role: v.string(),
  content: v.string(),
  created_at: v.number(),
  session_topic: v.nullable(v.string()),
  session_task_id: v.nullable(v.string()),
});

export type SearchResultParsed = {
  id: string;
  sessionId: string;
  role: string;
  content: string;
  createdAt: number;
  sessionTopic: string | null;
  sessionTaskId: string | null;
};

export function parseSearchResultRow(row: unknown): SearchResultParsed {
  const r = parseRow(SearchResultRowSchema, row, 'search_result');
  return {
    id: r.id,
    sessionId: r.session_id,
    role: r.role,
    content: r.content,
    createdAt: r.created_at,
    sessionTopic: r.session_topic,
    sessionTaskId: r.session_task_id,
  };
}
