/**
 * MCP library-file comment tools.
 *
 * Project-scoped (no session resolution needed). Agents can list and create
 * comment threads on library files without a chat session.
 *
 * Cross-references: apps/api/src/routes/library-comments.ts (HTTP routes)
 */
import type { Env } from '../../env';
import { log } from '../../lib/logger';
import {
  boundCommentThread,
  boundCommentThreadSummary,
  buildAgentCommentAuthor,
  clampCommentListLimit,
  getMessageCommentConfig,
  isMessageCommentServiceError,
  normalizeCommentBody,
  normalizeCommentQuote,
} from '../../services/message-comments';
import { assertLibraryFileInProject } from '../../services/library-file-comments';
import * as projectDataService from '../../services/project-data';
import {
  INTERNAL_ERROR,
  INVALID_PARAMS,
  jsonRpcError,
  type JsonRpcResponse,
  jsonRpcSuccess,
  type McpTokenData,
} from './_helpers';

const CALLER_DERIVED_FIELDS = [
  'projectId',
  'userId',
  'author',
  'authorId',
  'authorKind',
  'authorDisplayName',
  'provenance',
];

function toolSuccess(requestId: string | number | null, value: unknown): JsonRpcResponse {
  return jsonRpcSuccess(requestId, {
    content: [{ type: 'text', text: JSON.stringify(value) }],
  });
}

function rejectCallerDerivedFields(
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

function optionalString(params: Record<string, unknown>, field: string): string | null {
  const value = params[field];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function requiredString(
  requestId: string | number | null,
  params: Record<string, unknown>,
  field: string
): string | JsonRpcResponse {
  const value = optionalString(params, field);
  if (!value) return jsonRpcError(requestId, INVALID_PARAMS, `${field} is required`);
  return value;
}

function parseStatus(
  requestId: string | number | null,
  params: Record<string, unknown>
): 'open' | 'sent' | 'resolved' | 'all' | JsonRpcResponse {
  const raw = optionalString(params, 'status') ?? 'open';
  if (raw === 'open' || raw === 'sent' || raw === 'resolved' || raw === 'all') return raw;
  return jsonRpcError(requestId, INVALID_PARAMS, 'status must be open, sent, resolved, or all');
}

function mapCommentError(
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

function parseCursor(cursor: string | null): number | null {
  if (!cursor) return null;
  const parsed = Number.parseInt(cursor, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return parsed;
}

/**
 * Wraps the shared file->project binding check into this module's JSON-RPC error
 * shape. The query itself lives in services/library-file-comments.ts so the HTTP
 * routes and these tools cannot diverge on what "the file belongs to this
 * project" means.
 */
async function verifyFileInProject(
  requestId: string | number | null,
  env: Env,
  projectId: string,
  fileId: string
): Promise<JsonRpcResponse | null> {
  try {
    await assertLibraryFileInProject(env, projectId, fileId);
    return null;
  } catch {
    return jsonRpcError(requestId, INVALID_PARAMS, 'Library file not found');
  }
}

export async function handleListLibraryFileCommentThreads(
  requestId: string | number | null,
  params: Record<string, unknown>,
  tokenData: McpTokenData,
  env: Env
): Promise<JsonRpcResponse> {
  const identityError = rejectCallerDerivedFields(requestId, params);
  if (identityError) return identityError;
  const fileId = requiredString(requestId, params, 'fileId');
  if (typeof fileId !== 'string') return fileId;
  const status = parseStatus(requestId, params);
  if (typeof status !== 'string') return status;

  const fileError = await verifyFileInProject(requestId, env, tokenData.projectId, fileId);
  if (fileError) return fileError;

  const config = getMessageCommentConfig(env);
  const limit = clampCommentListLimit(params.limit, config);
  const cursor = optionalString(params, 'cursor');
  const afterSequence = parseCursor(cursor);

  try {
    const result = await projectDataService.listFileCommentThreads(env, tokenData.projectId, {
      fileId,
      status: status === 'all' ? null : status,
      afterSequence,
      limit,
    });
    const lastThread = result.threads.at(-1);
    const nextCursor =
      result.hasMore && typeof lastThread?.sequence === 'number'
        ? String(lastThread.sequence)
        : null;
    return toolSuccess(requestId, {
      threads: result.threads.map((thread) => boundCommentThreadSummary(thread, config)),
      hasMore: result.hasMore,
      nextCursor,
    });
  } catch (err) {
    return mapCommentError(requestId, err, 'mcp.library_file_comments.list_failed', {
      projectId: tokenData.projectId,
      fileId,
    });
  }
}

export async function handleCreateLibraryFileCommentThread(
  requestId: string | number | null,
  params: Record<string, unknown>,
  tokenData: McpTokenData,
  env: Env
): Promise<JsonRpcResponse> {
  const identityError = rejectCallerDerivedFields(requestId, params);
  if (identityError) return identityError;
  const fileId = requiredString(requestId, params, 'fileId');
  if (typeof fileId !== 'string') return fileId;
  const bodyRaw = requiredString(requestId, params, 'body');
  if (typeof bodyRaw !== 'string') return bodyRaw;

  const fileError = await verifyFileInProject(requestId, env, tokenData.projectId, fileId);
  if (fileError) return fileError;

  const config = getMessageCommentConfig(env);
  const body = normalizeCommentBody(bodyRaw, config);
  if (!body) return jsonRpcError(requestId, INVALID_PARAMS, 'body is required');

  const author = buildAgentCommentAuthor(tokenData);

  try {
    const result = await projectDataService.createFileCommentThread(env, tokenData.projectId, {
      fileId,
      body,
      quote: normalizeCommentQuote(optionalString(params, 'quote'), config),
      clientMutationId: null,
      actor: author,
    });
    return toolSuccess(requestId, {
      thread: boundCommentThread(result.thread, config),
    });
  } catch (err) {
    return mapCommentError(requestId, err, 'mcp.library_file_comments.create_failed', {
      projectId: tokenData.projectId,
      fileId,
    });
  }
}
