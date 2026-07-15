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
  // Added by migration 024-chat-message-origin; optional so pre-migration rows
  // and SELECTs that omit the column still parse (defaults to null → 'user').
  origin: v.optional(v.nullable(v.string())),
});

export function parseChatMessageRow(row: unknown): {
  id: string;
  sessionId: string;
  role: string;
  content: string;
  toolMetadata: unknown;
  createdAt: number;
  sequence: number | null;
  origin: string | null;
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
    origin: r.origin ?? null,
  };
}

/**
 * Parse a chat message row in compact mode: strips the `content` array from
 * tool_metadata and replaces it with a `contentSize` byte count.
 * This dramatically reduces RPC payload size for tool-heavy sessions.
 */
export type CompactMessageOptions = {
  documentCardRawOutputMaxBytes?: number;
};

export const DEFAULT_DOCUMENT_CARD_RAW_OUTPUT_MAX_BYTES = 16 * 1024;

export function parseChatMessageRowCompact(row: unknown, options?: CompactMessageOptions): {
  id: string;
  sessionId: string;
  role: string;
  content: string;
  toolMetadata: unknown;
  createdAt: number;
  sequence: number | null;
  origin: string | null;
} {
  const r = parseRow(ChatMessageRowSchema, row, 'chat_message');
  const parsed = safeParseJson(r.tool_metadata);
  const toolMetadata = parsed === null ? null : stripToolMetadataContent(parsed, options);
  return {
    id: r.id,
    sessionId: r.session_id,
    role: r.role,
    content: r.content,
    toolMetadata,
    createdAt: r.created_at,
    sequence: r.sequence,
    origin: r.origin ?? null,
  };
}

/**
 * Strip the heavy `content` array from parsed tool_metadata, replacing it
 * with a `contentSize` field indicating the byte count of the stripped content.
 * Preserves all other metadata fields (toolCallId, title, kind, status, locations).
 */
const textEncoder = new TextEncoder();
const DOCUMENT_CARD_TOOLS = new Set([
  'upload_to_library',
  'replace_library_file',
  'display_from_library',
]);
const TOOL_NAME_SEPARATORS = /__|\/|\.|:/;

function resolveDocumentCardRawOutputMaxBytes(options?: CompactMessageOptions): number {
  const configured = options?.documentCardRawOutputMaxBytes;
  return typeof configured === 'number' && Number.isFinite(configured) && configured > 0
    ? Math.floor(configured)
    : DEFAULT_DOCUMENT_CARD_RAW_OUTPUT_MAX_BYTES;
}

function normalizeToolName(toolName: unknown): string | undefined {
  if (typeof toolName !== 'string' || !toolName) return undefined;
  const segments = toolName.split(TOOL_NAME_SEPARATORS).filter(Boolean);
  return segments.length > 0 ? segments[segments.length - 1] : toolName;
}

function isDocumentCardTool(meta: Record<string, unknown>): boolean {
  const base = normalizeToolName(meta.toolName) ?? normalizeToolName(meta.title);
  return Boolean(base && DOCUMENT_CARD_TOOLS.has(base));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parseDocumentPayloadCandidate(
  value: string,
  maxBytes: number
): Record<string, unknown> | undefined {
  const trimmed = value.trim();
  if (!trimmed || textEncoder.encode(trimmed).byteLength > maxBytes) {
    return undefined;
  }

  const candidates = [trimmed];
  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.push(trimmed.slice(firstBrace, lastBrace + 1));
  }

  for (const candidate of candidates) {
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (isRecord(parsed) && isDocumentResultPayload(parsed)) {
        return parsed;
      }
    } catch {
      // Try the next candidate.
    }
  }

  return undefined;
}

function isDocumentResultPayload(payload: Record<string, unknown>): boolean {
  if (typeof payload.fileId === 'string' || typeof payload.id === 'string') return true;
  if (isRecord(payload.existingFile)) return true;
  return payload.error === 'FILE_NOT_FOUND' || payload.error === 'FILE_EXISTS';
}

function findDocumentPayload(
  value: unknown,
  maxBytes: number,
  depth = 0
): Record<string, unknown> | undefined {
  if (depth > 6 || value === null || value === undefined) return undefined;

  if (typeof value === 'string') {
    return parseDocumentPayloadCandidate(value, maxBytes);
  }

  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = findDocumentPayload(entry, maxBytes, depth + 1);
      if (found) return found;
    }
    return undefined;
  }

  if (!isRecord(value)) return undefined;

  for (const key of ['text', 'output', 'content', 'result', 'message']) {
    const found = findDocumentPayload(value[key], maxBytes, depth + 1);
    if (found) return found;
  }

  return undefined;
}

function extractDocumentCardRawOutput(
  meta: Record<string, unknown>,
  contentArray: unknown[],
  maxBytes: number
): Array<{ type: 'text'; text: string }> | undefined {
  if (!isDocumentCardTool(meta)) return undefined;
  if (meta.rawOutput !== undefined && meta.rawOutput !== null) return undefined;

  const payload = findDocumentPayload(contentArray, maxBytes);
  if (!payload) return undefined;

  const text = JSON.stringify(payload);
  if (textEncoder.encode(text).byteLength > maxBytes) {
    return undefined;
  }

  return [{ type: 'text', text }];
}

export function stripToolMetadataContent(meta: unknown, options?: CompactMessageOptions): unknown {
  if (!meta || typeof meta !== 'object') return meta;
  const obj = expectJsonRecord(meta, 'project-data.tool_metadata');
  const contentArray = obj.content;
  if (!Array.isArray(contentArray) || contentArray.length === 0) return meta;

  const contentJson = JSON.stringify(contentArray);
  const contentSize = textEncoder.encode(contentJson).byteLength;
  const rawOutput = extractDocumentCardRawOutput(
    obj,
    contentArray,
    resolveDocumentCardRawOutputMaxBytes(options)
  );

  const rest = Object.fromEntries(Object.entries(obj).filter(([k]) => k !== 'content'));
  return rawOutput ? { ...rest, rawOutput, contentSize } : { ...rest, contentSize };
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
