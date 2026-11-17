import { type Context } from 'hono';
import * as v from 'valibot';

import type { Env } from '../../env';
import { log } from '../../lib/logger';
import { parsePositiveInt } from '../../lib/route-helpers';
import { errors } from '../../middleware/error';
import { formatIssues, MessageBatchSchema } from '../../schemas';
import { nodeStatusTerminatesCallbacks } from '../../services/node-callback-auth';
import { persistError } from '../../services/observability';
import {
  loadWorkspaceCallbackIdentity,
  safeParseJson,
  type WorkspaceCallbackIdentitySnapshot,
} from './_helpers';

type RuntimeContext = Context<{ Bindings: Env }>;
type MessageBatchBody = v.InferOutput<typeof MessageBatchSchema>;
export const DEFAULT_MAX_MESSAGES_PAYLOAD_BYTES = 256 * 1024;
export const DEFAULT_MESSAGE_SIZE_THRESHOLD_BYTES = 102400;
export const ACTIVE_MESSAGE_WORKSPACE_STATUSES = new Set(['creating', 'running', 'recovery']);
export const VALID_MESSAGE_ROLES = new Set([
  'user',
  'assistant',
  'system',
  'tool',
  'thinking',
  'plan',
]);

export type MessageWorkspace = WorkspaceCallbackIdentitySnapshot & {
  projectId: string | null;
  chatSessionId: string | null;
};

export type MessageBatchPersistenceRouteResult = {
  persisted: number;
  duplicates: number;
  limitReached?: boolean;
  maxMessages?: number;
  remainingCapacity?: number;
};

export type MessageRouteContext = {
  workspaceId: string;
  projectId: string;
  sessionId: string;
  messageCount: number;
};

export function waitUntilIfAvailable(
  c: { executionCtx: { waitUntil(promise: Promise<unknown>): void } },
  promise: Promise<unknown> | void
): void {
  if (!promise) return;
  try {
    c.executionCtx.waitUntil(promise);
  } catch (err) {
    if (!(err instanceof Error) || !err.message.includes('no ExecutionContext')) {
      throw err;
    }
  }
}

export async function readRequestBodyWithLimit(
  request: Request,
  maxBytes: number
): Promise<string> {
  const contentLengthHeader = request.headers.get('content-length');
  if (contentLengthHeader) {
    const contentLength = Number.parseInt(contentLengthHeader, 10);
    if (!Number.isFinite(contentLength) || contentLength < 0) {
      throw errors.badRequest('Invalid Content-Length header');
    }
    if (contentLength > maxBytes) {
      throw errors.badRequest(`Payload exceeds ${maxBytes} byte limit`);
    }
  }

  if (!request.body) {
    return '';
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  let done = false;

  try {
    while (!done) {
      const read = await reader.read();
      done = read.done;
      if (done) continue;
      const { value } = read;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel();
        throw errors.badRequest(`Payload exceeds ${maxBytes} byte limit`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}

export async function parseMessageBatchRequest(c: RuntimeContext): Promise<MessageBatchBody> {
  const maxPayloadBytes = parsePositiveInt(
    c.env.MAX_MESSAGES_PAYLOAD_BYTES as string,
    DEFAULT_MAX_MESSAGES_PAYLOAD_BYTES
  );
  const rawBody = await readRequestBodyWithLimit(c.req.raw, maxPayloadBytes);

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    throw errors.badRequest('Invalid JSON in request body');
  }

  const result = v.safeParse(MessageBatchSchema, parsed);
  if (!result.success) {
    throw errors.badRequest(formatIssues(result.issues));
  }
  return result.output;
}

export function resolveMaxMessageBytes(env: Env): number {
  return env.MESSAGE_SIZE_THRESHOLD
    ? Number.parseInt(env.MESSAGE_SIZE_THRESHOLD, 10)
    : DEFAULT_MESSAGE_SIZE_THRESHOLD_BYTES;
}

export function validateMessageEntry(
  msg: MessageBatchBody['messages'][number],
  maxMessageBytes: number
): void {
  if (!msg.messageId) {
    throw errors.badRequest('Each message must have a messageId string');
  }
  if (!msg.sessionId) {
    throw errors.badRequest('Each message must have a sessionId string');
  }
  if (!msg.role || !VALID_MESSAGE_ROLES.has(msg.role)) {
    throw errors.badRequest(
      `Invalid role "${msg.role}". Must be one of: user, assistant, system, tool, thinking, plan`
    );
  }
  if (!msg.content) {
    throw errors.badRequest('Each message must have non-empty content');
  }
  if (msg.content.length > maxMessageBytes) {
    throw errors.badRequest(`Individual message content exceeds ${maxMessageBytes} byte limit`);
  }
  if (!msg.timestamp) {
    throw errors.badRequest('Each message must have a timestamp string');
  }
}

export function validateMessageBatch(env: Env, body: MessageBatchBody): string {
  if (body.messages.length === 0) {
    throw errors.badRequest('messages array must not be empty');
  }
  const maxMessagesPerBatch = parsePositiveInt(env.MAX_MESSAGES_PER_BATCH, 100);
  if (body.messages.length > maxMessagesPerBatch) {
    throw errors.badRequest(`Maximum ${maxMessagesPerBatch} messages per batch`);
  }

  const firstMessage = body.messages[0];
  if (!firstMessage) {
    throw errors.badRequest('messages array must not be empty');
  }
  const maxMessageBytes = resolveMaxMessageBytes(env);
  const sessionId = firstMessage.sessionId;
  for (const msg of body.messages) {
    validateMessageEntry(msg, maxMessageBytes);
    if (msg.sessionId !== sessionId) {
      throw errors.badRequest('All messages in a batch must target the same sessionId');
    }
  }
  return sessionId;
}

export function loadMessageWorkspace(
  env: Env,
  workspaceId: string
): Promise<MessageWorkspace | null> {
  return loadWorkspaceCallbackIdentity(env, workspaceId);
}

export function terminalMessagePersistenceResponse(
  c: RuntimeContext,
  context: Omit<MessageRouteContext, 'projectId'> & { projectId: string | null },
  status: string,
  reason: string
): Response {
  const logContext = {
    ...context,
    status,
    reason,
    action: 'dropped_terminal_resource',
  };
  log.info('message_persistence.inactive_workspace', logContext);
  return c.body(null, 204);
}

export function maybeTerminalMessageWorkspaceResponse(
  c: RuntimeContext,
  workspace: MessageWorkspace | null,
  workspaceId: string,
  sessionId: string,
  messageCount: number
): Response | null {
  const context = {
    workspaceId,
    projectId: workspace?.projectId ?? null,
    sessionId,
    messageCount,
  };
  if (!workspace) {
    return terminalMessagePersistenceResponse(c, context, 'missing', 'workspace_missing');
  }
  if (!ACTIVE_MESSAGE_WORKSPACE_STATUSES.has(workspace.status)) {
    return terminalMessagePersistenceResponse(c, context, workspace.status, 'workspace_inactive');
  }
  if (
    !workspace.nodeId ||
    !workspace.nodeStatus ||
    nodeStatusTerminatesCallbacks(workspace.nodeStatus)
  ) {
    return terminalMessagePersistenceResponse(
      c,
      context,
      workspace.nodeStatus ?? 'missing',
      'workspace_node_terminal'
    );
  }
  return null;
}

export function rejectMessageSessionMismatch(
  c: RuntimeContext,
  context: MessageRouteContext,
  expectedSessionId: string
): never {
  const logContext = {
    ...context,
    expectedSessionId,
    receivedSessionId: context.sessionId,
    action: 'rejected_batch',
  };
  log.error('message_routing.session_mismatch', logContext);
  waitUntilIfAvailable(
    c,
    persistError(
      c.env.OBSERVABILITY_DATABASE,
      {
        source: 'api',
        level: 'error',
        message: `Message routing mismatch: workspace ${context.workspaceId} linked to session ${expectedSessionId}, but messages target ${context.sessionId}`,
        context: logContext,
        workspaceId: context.workspaceId,
      },
      c.env
    )
  );
  throw errors.badRequest(
    `Session mismatch: workspace is linked to session ${expectedSessionId}, ` +
      `but messages target session ${context.sessionId}`
  );
}

export function rejectWorkspaceWithoutChatSession(
  c: RuntimeContext,
  context: MessageRouteContext
): never {
  const logContext = {
    ...context,
    providedSessionId: context.sessionId,
    action: 'rejected_no_session_link',
  };
  log.warn('message_routing.no_chat_session_linked', logContext);
  waitUntilIfAvailable(
    c,
    persistError(
      c.env.OBSERVABILITY_DATABASE,
      {
        source: 'api',
        level: 'warn',
        message: `Rejecting messages for workspace ${context.workspaceId}: no chatSessionId linked yet`,
        context: logContext,
        workspaceId: context.workspaceId,
      },
      c.env
    )
  );
  throw errors.conflict(
    'Workspace has no linked chat session yet — messages cannot be routed safely'
  );
}

export function assertMessageWorkspaceAcceptsBatch(
  c: RuntimeContext,
  workspace: MessageWorkspace | null,
  workspaceId: string,
  sessionId: string,
  messageCount: number
): asserts workspace is MessageWorkspace & { projectId: string; chatSessionId: string } {
  if (!workspace) {
    throw errors.notFound('Workspace');
  }
  if (!workspace.projectId) {
    throw errors.badRequest('Workspace is not linked to a project');
  }

  const context: MessageRouteContext = {
    workspaceId,
    projectId: workspace.projectId,
    sessionId,
    messageCount,
  };
  if (workspace.chatSessionId && workspace.chatSessionId !== sessionId) {
    rejectMessageSessionMismatch(c, context, workspace.chatSessionId);
  }
  if (!workspace.chatSessionId) {
    rejectWorkspaceWithoutChatSession(c, context);
  }
}

export function toProjectDataMessages(body: MessageBatchBody) {
  return body.messages.map((m) => ({
    messageId: m.messageId,
    role: m.role,
    content: m.content,
    toolMetadata: m.toolMetadata ? safeParseJson(m.toolMetadata) : null,
    timestamp: m.timestamp,
    sequence: m.sequence,
    origin: m.origin ?? null,
  }));
}

export function sessionLimitReachedResponse(
  c: RuntimeContext,
  context: MessageRouteContext
): Response {
  log.error('message_persistence.session_message_limit_exceeded', {
    ...context,
    action: 'rejected_session_message_limit',
  });
  waitUntilIfAvailable(
    c,
    persistError(
      c.env.OBSERVABILITY_DATABASE,
      {
        source: 'api',
        level: 'error',
        message: `Session ${context.sessionId} has reached the message limit`,
        context: { ...context, action: 'rejected_session_message_limit' },
        workspaceId: context.workspaceId,
      },
      c.env
    )
  );
  return c.json(
    {
      error: 'SESSION_MESSAGE_LIMIT_EXCEEDED',
      message: 'Session message limit reached; no additional messages can be persisted',
    },
    409
  );
}

export function handleMessagePersistenceError(
  c: RuntimeContext,
  context: MessageRouteContext,
  err: unknown
): Response {
  const message = err instanceof Error ? err.message : 'Failed to persist messages';
  if (message.includes('SESSION_MESSAGE_LIMIT_EXCEEDED') || message.includes('message limit')) {
    return sessionLimitReachedResponse(c, context);
  }
  if (message.includes('not found') || message.includes('is stopped')) {
    log.info('message_persistence.dropped_terminal_do_response', {
      ...context,
      error: message,
      action: 'dropped_terminal_resource',
    });
    return c.body(null, 204);
  }
  log.error('message_persistence.do_error_transient', {
    ...context,
    error: message,
    action: 'rejected_transient',
  });
  return c.json(
    { error: 'SERVICE_UNAVAILABLE', message: 'Message persistence temporarily unavailable' },
    503
  );
}

export function partialSessionLimitResponse(
  c: RuntimeContext,
  context: MessageRouteContext,
  result: MessageBatchPersistenceRouteResult
): Response {
  const logContext = {
    ...context,
    persisted: result.persisted,
    duplicates: result.duplicates,
    maxMessages: result.maxMessages,
    remainingCapacity: result.remainingCapacity,
    action: 'partial_persist_session_message_limit',
  };
  log.error('message_persistence.session_message_limit_reached', logContext);
  waitUntilIfAvailable(
    c,
    persistError(
      c.env.OBSERVABILITY_DATABASE,
      {
        source: 'api',
        level: 'error',
        message: `Session ${context.sessionId} reached the message limit while persisting a batch`,
        context: logContext,
        workspaceId: context.workspaceId,
      },
      c.env
    )
  );
  return c.json(
    {
      error: 'SESSION_MESSAGE_LIMIT_EXCEEDED',
      message: 'Session message limit reached; only part of the batch was persisted',
      persisted: result.persisted,
      duplicates: result.duplicates,
      maxMessages: result.maxMessages,
      remainingCapacity: result.remainingCapacity,
    },
    409
  );
}
