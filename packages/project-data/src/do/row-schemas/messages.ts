import { REQUEST_SECRET_TOOL } from '@simple-agent-manager/shared';
import { expectJsonRecord, maybeJsonRecord } from '@simple-agent-manager/worker-core';
import * as v from 'valibot';

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

export function parseChatMessageRowCompact(
  row: unknown,
  options?: CompactMessageOptions
): {
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
/**
 * Operations approval request tool. Its chat card needs only the approval ID: the card
 * reads action, target, reason and status from the server record, never from chat text.
 */
const APPROVAL_CARD_TOOL = 'ops_request_action';
/**
 * Agent question tool. Its chat card needs only the attention marker and session IDs: the
 * card reads the question, options and answer state from the server marker.
 */
const HUMAN_INPUT_CARD_TOOL = 'request_human_input';
/**
 * Agent secret request tool. Its chat card needs only the request ID: the card reads name,
 * reason and status from the server record. Keep in sync with SECRET_REQUEST_CARD_TOOL in
 * apps/web (secret-request-card-data.ts).
 */
const SECRET_REQUEST_CARD_TOOL = REQUEST_SECRET_TOOL;
const TOOL_NAME_SEPARATORS = /__|\/|\.|:/;

type CardPayloadMatcher = (payload: Record<string, unknown>) => Record<string, unknown> | undefined;

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

function documentPayload(payload: Record<string, unknown>): Record<string, unknown> | undefined {
  if (typeof payload.fileId === 'string' || typeof payload.id === 'string') return payload;
  if (maybeJsonRecord(payload.existingFile)) return payload;
  return payload.error === 'FILE_NOT_FOUND' || payload.error === 'FILE_EXISTS'
    ? payload
    : undefined;
}

/** Keeps only the approval ID; the rest of the result is untrusted and re-read by the card. */
function approvalPayload(payload: Record<string, unknown>): Record<string, unknown> | undefined {
  const approval = maybeJsonRecord(payload.approval);
  const id = approval?.id;
  return typeof id === 'string' && id ? { approval: { id } } : undefined;
}

/** Keeps only the attention marker reference; the card re-reads the question from the server. */
function humanInputPayload(payload: Record<string, unknown>): Record<string, unknown> | undefined {
  const request = maybeJsonRecord(payload.humanInputRequest);
  const id = request?.id;
  const sessionId = request?.sessionId;
  return typeof id === 'string' && id && typeof sessionId === 'string' && sessionId
    ? { humanInputRequest: { id, sessionId } }
    : undefined;
}

/** Keeps only the secret request ID; the card re-reads everything else from the server. */
function secretRequestPayload(
  payload: Record<string, unknown>
): Record<string, unknown> | undefined {
  const request = maybeJsonRecord(payload.secretRequest);
  const id = request?.id;
  return typeof id === 'string' && id ? { secretRequest: { id } } : undefined;
}

/** Which typed chat card a tool renders as, and how to recognise its result payload. */
function cardPayloadMatcher(meta: Record<string, unknown>): CardPayloadMatcher | undefined {
  const base = normalizeToolName(meta.toolName) ?? normalizeToolName(meta.title);
  if (!base) return undefined;
  if (DOCUMENT_CARD_TOOLS.has(base)) return documentPayload;
  if (base === APPROVAL_CARD_TOOL) return approvalPayload;
  if (base === HUMAN_INPUT_CARD_TOOL) return humanInputPayload;
  if (base === SECRET_REQUEST_CARD_TOOL) return secretRequestPayload;
  return undefined;
}

function parsePayloadCandidate(
  value: string,
  maxBytes: number,
  match: CardPayloadMatcher
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
      // maybeJsonRecord accepts arrays (valibot's record schema treats numeric
      // indices as string keys). The matchers only accept named keys
      // (fileId/id/existingFile/error/approval) that a JSON array can never
      // carry at its top level.
      const record = maybeJsonRecord(parsed);
      const matched = record ? match(record) : undefined;
      if (matched) return matched;
    } catch {
      // Try the next candidate.
    }
  }

  return undefined;
}

function findCardPayload(
  value: unknown,
  maxBytes: number,
  match: CardPayloadMatcher,
  depth = 0
): Record<string, unknown> | undefined {
  if (depth > 6 || value === null || value === undefined) return undefined;

  if (typeof value === 'string') {
    return parsePayloadCandidate(value, maxBytes, match);
  }

  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = findCardPayload(entry, maxBytes, match, depth + 1);
      if (found) return found;
    }
    return undefined;
  }

  const record = maybeJsonRecord(value);
  if (!record) return undefined;

  for (const key of ['text', 'output', 'content', 'result', 'message']) {
    const found = findCardPayload(record[key], maxBytes, match, depth + 1);
    if (found) return found;
  }

  return undefined;
}

/**
 * Compact mode drops tool `content`. For tools that render a typed chat card (library
 * documents, Operations approvals) keep the card-critical payload as `rawOutput`, so the
 * card still renders after a reload when the VM agent did not capture rawOutput itself.
 */
function extractCardRawOutput(
  meta: Record<string, unknown>,
  contentArray: unknown[],
  maxBytes: number
): Array<{ type: 'text'; text: string }> | undefined {
  const match = cardPayloadMatcher(meta);
  if (!match) return undefined;
  if (meta.rawOutput !== undefined && meta.rawOutput !== null) return undefined;

  const payload = findCardPayload(contentArray, maxBytes, match);
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
  const rawOutput = extractCardRawOutput(
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
