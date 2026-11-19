import type {
  MessageCommentActorProvenance,
  MessageCommentAuthor,
  MessageCommentDirectiveState,
  MessageCommentListRequest,
  MessageCommentListResponse,
  MessageCommentThread,
  MessageCommentThreadStatus,
  UpdateMessageCommentThreadStatusRequest,
} from '@simple-agent-manager/shared';

import type { Env } from '../env';
import { redactCredentialTokens } from '../lib/credential-token-redaction';
import { parsePositiveInt } from '../lib/route-helpers';
import { sanitizeUserInput } from '../lib/sanitize-user-input';
import * as projectDataService from './project-data';

const DEFAULT_MCP_COMMENT_LIST_LIMIT = 10;
const DEFAULT_MCP_COMMENT_LIST_MAX = 25;
const DEFAULT_MCP_COMMENT_BODY_MAX_LENGTH = 4_000;
const DEFAULT_MCP_COMMENT_QUOTE_MAX_LENGTH = 1_000;
const DEFAULT_COMMENT_DIRECTIVE_CONTEXT_MAX_LENGTH = 6_000;

export interface MessageCommentConfigEnv {
  MCP_COMMENT_LIST_LIMIT?: string;
  MCP_COMMENT_LIST_MAX?: string;
  MCP_COMMENT_BODY_MAX_LENGTH?: string;
  MCP_COMMENT_QUOTE_MAX_LENGTH?: string;
  COMMENT_DIRECTIVE_CONTEXT_MAX_LENGTH?: string;
}

export interface MessageCommentConfig {
  listLimit: number;
  listMax: number;
  bodyMaxLength: number;
  quoteMaxLength: number;
  directiveContextMaxLength: number;
}

export function getMessageCommentConfig(env: MessageCommentConfigEnv): MessageCommentConfig {
  const listLimit = parsePositiveInt(env.MCP_COMMENT_LIST_LIMIT, DEFAULT_MCP_COMMENT_LIST_LIMIT);
  const listMax = parsePositiveInt(env.MCP_COMMENT_LIST_MAX, DEFAULT_MCP_COMMENT_LIST_MAX);
  return {
    listLimit,
    listMax: Math.max(listLimit, listMax),
    bodyMaxLength: parsePositiveInt(
      env.MCP_COMMENT_BODY_MAX_LENGTH,
      DEFAULT_MCP_COMMENT_BODY_MAX_LENGTH
    ),
    quoteMaxLength: parsePositiveInt(
      env.MCP_COMMENT_QUOTE_MAX_LENGTH,
      DEFAULT_MCP_COMMENT_QUOTE_MAX_LENGTH
    ),
    directiveContextMaxLength: parsePositiveInt(
      env.COMMENT_DIRECTIVE_CONTEXT_MAX_LENGTH,
      DEFAULT_COMMENT_DIRECTIVE_CONTEXT_MAX_LENGTH
    ),
  };
}

export type MessageCommentErrorCode =
  'invalid_request' | 'not_found' | 'forbidden' | 'conflict' | 'unavailable';

export class MessageCommentServiceError extends Error {
  constructor(
    readonly code: MessageCommentErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'MessageCommentServiceError';
  }
}

export function isMessageCommentServiceError(err: unknown): err is MessageCommentServiceError {
  return err instanceof MessageCommentServiceError;
}

export interface MessageCommentThreadLookup {
  projectId: string;
  sessionId: string;
  threadId: string;
}

export interface CreateMessageCommentThreadInput {
  projectId: string;
  sessionId: string;
  messageId: string;
  quote: string | null;
  body: string;
  author: MessageCommentAuthor;
  provenance: MessageCommentActorProvenance;
}

export interface ReplyToMessageCommentThreadInput {
  projectId: string;
  sessionId: string;
  threadId: string;
  body: string;
  author: MessageCommentAuthor;
  provenance: MessageCommentActorProvenance;
}

export interface ObserveMessageCommentThreadInput extends MessageCommentThreadLookup {
  observer: MessageCommentAuthor;
  provenance: MessageCommentActorProvenance;
}

export interface RecordMessageCommentDirectiveInput extends MessageCommentThreadLookup {
  delivery: MessageCommentDirectiveState;
  sentByUserId: string;
  sentByName: string | null;
  sentAt: number;
}

export interface MessageCommentStorageAdapter {
  listThreads(
    projectId: string,
    input: MessageCommentListRequest
  ): Promise<MessageCommentListResponse>;
  getThread(input: MessageCommentThreadLookup): Promise<MessageCommentThread | null>;
  createThread(input: CreateMessageCommentThreadInput): Promise<MessageCommentThread>;
  replyToThread(input: ReplyToMessageCommentThreadInput): Promise<MessageCommentThread>;
  updateThreadStatus(
    input: { projectId: string } & UpdateMessageCommentThreadStatusRequest
  ): Promise<MessageCommentThread>;
  markThreadObserved(input: ObserveMessageCommentThreadInput): Promise<{ observed: boolean }>;
  recordDirectiveDelivery(
    input: RecordMessageCommentDirectiveInput
  ): Promise<MessageCommentThread | null>;
}

export function getAuthorDisplayName(author: MessageCommentAuthor): string | null {
  return author.displayName ?? author.name ?? null;
}

function toStorageActor(author: MessageCommentAuthor): MessageCommentAuthor {
  const displayName = getAuthorDisplayName(author);
  return {
    kind: author.kind,
    id: author.id,
    name: displayName,
    displayName,
  };
}

function withCommentDisplayNames(thread: MessageCommentThread): MessageCommentThread {
  const mapAuthor = (author: MessageCommentAuthor): MessageCommentAuthor => ({
    ...author,
    displayName: getAuthorDisplayName(author),
  });
  return {
    ...thread,
    author: mapAuthor(thread.author),
    sentBy: thread.sentBy ? mapAuthor(thread.sentBy) : (thread.sentBy ?? null),
    resolvedBy: thread.resolvedBy ? mapAuthor(thread.resolvedBy) : (thread.resolvedBy ?? null),
    reopenedBy: thread.reopenedBy ? mapAuthor(thread.reopenedBy) : (thread.reopenedBy ?? null),
    replies: thread.replies.map((reply) => ({
      ...reply,
      author: mapAuthor(reply.author),
    })),
  };
}

function cursorToAfterSequence(cursor: string | null | undefined): number | null {
  if (!cursor) return null;
  const parsed = Number.parseInt(cursor, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new MessageCommentServiceError('invalid_request', 'cursor must be a comment sequence');
  }
  return parsed;
}

function addNextCursor(result: MessageCommentListResponse): MessageCommentListResponse {
  const lastThread = result.threads.at(-1);
  const nextCursor =
    result.hasMore && typeof lastThread?.sequence === 'number' ? String(lastThread.sequence) : null;
  return {
    ...result,
    threads: result.threads.map(withCommentDisplayNames),
    nextCursor,
  };
}

export function createProjectDataMessageCommentAdapter(env: Env): MessageCommentStorageAdapter {
  return {
    async listThreads(projectId, input) {
      const result = await projectDataService.listCommentThreads(env, projectId, {
        sessionId: input.sessionId,
        messageId: input.messageId ?? null,
        status: input.status === 'all' ? null : (input.status ?? null),
        afterSequence: cursorToAfterSequence(input.cursor),
        limit: input.limit,
      });
      return addNextCursor(result);
    },
    async getThread(input) {
      const thread = await projectDataService.getCommentThread(
        env,
        input.projectId,
        input.sessionId,
        input.threadId
      );
      return thread ? withCommentDisplayNames(thread) : null;
    },
    async createThread(input) {
      const result = await projectDataService.createCommentThread(env, input.projectId, {
        sessionId: input.sessionId,
        messageId: input.messageId,
        quote: input.quote,
        body: input.body,
        clientMutationId: null,
        actor: toStorageActor(input.author),
      });
      return withCommentDisplayNames(result.thread);
    },
    async replyToThread(input) {
      const result = await projectDataService.createCommentReply(env, input.projectId, {
        sessionId: input.sessionId,
        threadId: input.threadId,
        body: input.body,
        clientMutationId: null,
        actor: toStorageActor(input.author),
      });
      return withCommentDisplayNames(result.thread);
    },
    async updateThreadStatus(input) {
      const result = await projectDataService.updateCommentThreadStatus(env, input.projectId, {
        sessionId: input.sessionId,
        threadId: input.threadId,
        status: input.status,
        clientMutationId: null,
        actor: toStorageActor(input.actor),
      });
      return withCommentDisplayNames(result.thread);
    },
    async markThreadObserved() {
      return { observed: false };
    },
    async recordDirectiveDelivery(input) {
      const result = await projectDataService.updateCommentThreadStatus(env, input.projectId, {
        sessionId: input.sessionId,
        threadId: input.threadId,
        status: 'sent',
        clientMutationId: input.delivery.deliveryId,
        actor: {
          kind: 'human',
          id: input.sentByUserId,
          name: input.sentByName,
          displayName: input.sentByName,
        },
      });
      return {
        ...withCommentDisplayNames(result.thread),
        directive: input.delivery,
      };
    },
  };
}

export function normalizeCommentBody(raw: string, config: MessageCommentConfig): string {
  return redactSensitiveText(sanitizeUserInput(raw).trim()).slice(0, config.bodyMaxLength);
}

export function normalizeCommentQuote(
  raw: string | null | undefined,
  config: MessageCommentConfig
): string | null {
  if (typeof raw !== 'string') return null;
  const normalized = redactSensitiveText(sanitizeUserInput(raw).trim()).slice(
    0,
    config.quoteMaxLength
  );
  return normalized || null;
}

export function clampCommentListLimit(rawLimit: unknown, config: MessageCommentConfig): number {
  if (typeof rawLimit !== 'number' || !Number.isFinite(rawLimit) || rawLimit <= 0) {
    return config.listLimit;
  }
  return Math.min(Math.floor(rawLimit), config.listMax);
}

export function boundCommentThreadSummary<
  T extends {
    body: string;
    anchor: { quote: string | null };
    sourceMessage?: { quote: string | null } | null;
  },
>(thread: T, config: MessageCommentConfig): T {
  return {
    ...thread,
    body: normalizeCommentBody(thread.body, config),
    anchor: {
      ...thread.anchor,
      quote: normalizeCommentQuote(thread.anchor.quote, config),
    },
    ...(Object.prototype.hasOwnProperty.call(thread, 'sourceMessage')
      ? {
          sourceMessage: thread.sourceMessage
            ? {
                ...thread.sourceMessage,
                quote: normalizeCommentQuote(thread.sourceMessage.quote, config),
              }
            : null,
        }
      : {}),
  };
}

/**
 * Generic over the thread shape so message threads and library-file threads
 * share one bounding implementation — both need bodies and quotes clamped to the
 * same configured limits before they reach an agent.
 */
export function boundCommentThread<
  T extends {
    body: string;
    anchor: { quote: string | null };
    sourceMessage?: { quote: string | null } | null;
    replies: Array<{ body: string }>;
  },
>(thread: T, config: MessageCommentConfig): T {
  const summary = boundCommentThreadSummary(thread, config);
  return {
    ...summary,
    replies: thread.replies.map((reply) => ({
      ...reply,
      body: normalizeCommentBody(reply.body, config),
    })),
  };
}

export function buildAgentCommentAuthor(tokenData: {
  agentSessionId?: string;
  workspaceId?: string;
  taskId?: string;
}): MessageCommentAuthor {
  const displayName = 'SAM agent';
  return {
    kind: 'agent',
    id: tokenData.agentSessionId || tokenData.workspaceId || tokenData.taskId || 'agent',
    displayName,
  };
}

export function buildAgentCommentProvenance(tokenData: {
  projectId: string;
  userId: string;
  taskId?: string;
  workspaceId?: string;
  agentSessionId?: string;
}): MessageCommentActorProvenance {
  return {
    projectId: tokenData.projectId,
    userId: tokenData.userId,
    taskId: tokenData.taskId || null,
    workspaceId: tokenData.workspaceId || null,
    agentSessionId: tokenData.agentSessionId || null,
  };
}

function redactSensitiveText(value: string): string {
  return redactCredentialTokens(value, '[redacted]')
    .replace(/\b(Bearer)\s+[A-Za-z0-9._~+/=-]{12,}/gi, '$1 [redacted]')
    .replace(/\b(token|api[_-]?key|secret|password)\s*[:=]\s*[^\s'"`<>]{8,}/gi, '$1=[redacted]');
}

export function assertCommentStatus(value: string): MessageCommentThreadStatus | 'all' | null {
  if (value === 'open' || value === 'sent' || value === 'resolved' || value === 'all') {
    return value;
  }
  return null;
}
