/**
 * Shared JSON-RPC plumbing for the agent-facing comment tools.
 *
 * `comment-tools.ts` (message-anchored) and `library-file-comment-tools.ts`
 * (library-file-anchored) had byte-identical copies of all of this. One
 * implementation, so the two tool surfaces cannot drift on how they reject
 * caller-supplied identity, coerce params, or map errors
 * (.claude/rules/24-no-duplicate-ui-controls.md).
 */

import type { MessageCommentThreadStatus } from '@simple-agent-manager/shared';

import { log } from '../../lib/logger';
import { isMessageCommentServiceError } from '../../services/message-comments';
import {
  INTERNAL_ERROR,
  INVALID_PARAMS,
  jsonRpcError,
  type JsonRpcResponse,
  jsonRpcSuccess,
} from './_helpers';

/**
 * Fields the server derives from the verified MCP token. An agent supplying any
 * of them is either confused or attempting to act as someone else; either way
 * the call is rejected rather than silently overridden.
 */
const CALLER_DERIVED_FIELDS = [
  'projectId',
  'userId',
  'author',
  'authorId',
  'authorKind',
  'authorDisplayName',
  'provenance',
];

export function toolSuccess(requestId: string | number | null, value: unknown): JsonRpcResponse {
  return jsonRpcSuccess(requestId, {
    content: [{ type: 'text', text: JSON.stringify(value) }],
  });
}

export function rejectCallerDerivedFields(
  requestId: string | number | null,
  params: Record<string, unknown>
): JsonRpcResponse | null {
  for (const field of CALLER_DERIVED_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(params, field)) {
      return jsonRpcError(
        requestId,
        INVALID_PARAMS,
        `${field} is derived from the verified MCP token and must not be supplied`
      );
    }
  }
  return null;
}

export function optionalString(params: Record<string, unknown>, field: string): string | null {
  const value = params[field];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function requiredString(
  requestId: string | number | null,
  params: Record<string, unknown>,
  field: string
): string | JsonRpcResponse {
  const value = optionalString(params, field);
  if (!value) return jsonRpcError(requestId, INVALID_PARAMS, `${field} is required`);
  return value;
}

export function parseStatusFilter(
  requestId: string | number | null,
  params: Record<string, unknown>
): MessageCommentThreadStatus | 'all' | JsonRpcResponse {
  const raw = optionalString(params, 'status') ?? 'open';
  if (raw === 'open' || raw === 'sent' || raw === 'resolved' || raw === 'all') return raw;
  return jsonRpcError(requestId, INVALID_PARAMS, 'status must be open, sent, resolved, or all');
}

export function mapCommentError(
  requestId: string | number | null,
  err: unknown,
  logTag: string,
  logContext: Record<string, unknown>
): JsonRpcResponse {
  if (isMessageCommentServiceError(err)) {
    const code = err.code === 'unavailable' ? INTERNAL_ERROR : INVALID_PARAMS;
    return jsonRpcError(requestId, code, err.message);
  }
  log.warn(logTag, {
    ...logContext,
    error: err instanceof Error ? err.message : String(err),
  });
  return jsonRpcError(requestId, INTERNAL_ERROR, 'Comment tool failed');
}
