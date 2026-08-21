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

import { resolveDurableExecutionConfig } from '../durable-objects/project-data/durable-execution-config';
import type { Env } from '../env';
import { log } from '../lib/logger';
import { parsePositiveInt } from '../lib/route-helpers';
import { sanitizeUserInput } from '../lib/sanitize-user-input';
import * as projectDataService from './project-data';
import { ensureOncePerIsolate, forgetEnsuredProjectData } from './project-data-ensure-memo';

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
  | 'invalid_request'
  | 'not_found'
  | 'forbidden'
  | 'conflict'
  | 'unavailable';

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

type ProjectDataCommentRpc = {
  ensureProjectId?: (projectId: string) => Promise<void>;
  listMessageCommentThreads?: (
    input: MessageCommentListRequest
  ) => Promise<MessageCommentListResponse>;
  getMessageCommentThread?: (input: {
    sessionId: string;
    threadId: string;
  }) => Promise<MessageCommentThread | null>;
  createMessageCommentThread?: (
    input: Omit<CreateMessageCommentThreadInput, 'projectId'>
  ) => Promise<MessageCommentThread>;
  replyToMessageCommentThread?: (
    input: Omit<ReplyToMessageCommentThreadInput, 'projectId'>
  ) => Promise<MessageCommentThread>;
  updateMessageCommentThreadStatus?: (
    input: UpdateMessageCommentThreadStatusRequest
  ) => Promise<MessageCommentThread>;
  markMessageCommentThreadObserved?: (
    input: Omit<ObserveMessageCommentThreadInput, 'projectId'>
  ) => Promise<{ observed: boolean }>;
  recordMessageCommentDirectiveDelivery?: (
    input: Omit<RecordMessageCommentDirectiveInput, 'projectId'>
  ) => Promise<MessageCommentThread | null>;
};

async function getProjectDataCommentRpc(
  env: Env,
  projectId: string
): Promise<ProjectDataCommentRpc> {
  const id = env.PROJECT_DATA.idFromName(projectId);
  const doId = id.toString();
  const stub = env.PROJECT_DATA.get(id) as unknown as ProjectDataCommentRpc;
  if (typeof stub.ensureProjectId === 'function') {
    await ensureOncePerIsolate(
      env,
      doId,
      () => stub.ensureProjectId?.(projectId) ?? Promise.resolve()
    );
  }
  return stub;
}

async function callProjectDataCommentRpc<K extends keyof ProjectDataCommentRpc, T>(
  env: Env,
  projectId: string,
  method: K,
  call: (rpcMethod: NonNullable<ProjectDataCommentRpc[K]>) => Promise<T>
): Promise<T> {
  const id = env.PROJECT_DATA.idFromName(projectId);
  try {
    const stub = await getProjectDataCommentRpc(env, projectId);
    const rpcMethod = stub[method];
    if (typeof rpcMethod !== 'function') {
      throw new MessageCommentServiceError(
        'unavailable',
        'Comment storage backend is not installed'
      );
    }
    return await call(rpcMethod as NonNullable<ProjectDataCommentRpc[K]>);
  } catch (err) {
    forgetEnsuredProjectData(id.toString());
    if (isMessageCommentServiceError(err)) throw err;
    log.warn('message_comments.project_data_rpc_failed', {
      projectId,
      method,
      error: err instanceof Error ? err.message : String(err),
    });
    throw new MessageCommentServiceError('unavailable', 'Comment storage backend is unavailable');
  }
}

export function createProjectDataMessageCommentAdapter(env: Env): MessageCommentStorageAdapter {
  return {
    listThreads(projectId, input) {
      return callProjectDataCommentRpc(env, projectId, 'listMessageCommentThreads', (listThreads) =>
        listThreads(input)
      );
    },
    getThread(input) {
      return callProjectDataCommentRpc(
        env,
        input.projectId,
        'getMessageCommentThread',
        (getThread) => getThread({ sessionId: input.sessionId, threadId: input.threadId })
      );
    },
    createThread(input) {
      const rpcInput: Omit<CreateMessageCommentThreadInput, 'projectId'> = {
        sessionId: input.sessionId,
        messageId: input.messageId,
        quote: input.quote,
        body: input.body,
        author: input.author,
        provenance: input.provenance,
      };
      return callProjectDataCommentRpc(
        env,
        input.projectId,
        'createMessageCommentThread',
        (createThread) => createThread(rpcInput)
      );
    },
    replyToThread(input) {
      const rpcInput: Omit<ReplyToMessageCommentThreadInput, 'projectId'> = {
        sessionId: input.sessionId,
        threadId: input.threadId,
        body: input.body,
        author: input.author,
        provenance: input.provenance,
      };
      return callProjectDataCommentRpc(
        env,
        input.projectId,
        'replyToMessageCommentThread',
        (replyToThread) => replyToThread(rpcInput)
      );
    },
    updateThreadStatus(input) {
      const rpcInput: UpdateMessageCommentThreadStatusRequest = {
        sessionId: input.sessionId,
        threadId: input.threadId,
        status: input.status,
        actor: input.actor,
        provenance: input.provenance,
      };
      return callProjectDataCommentRpc(
        env,
        input.projectId,
        'updateMessageCommentThreadStatus',
        (updateStatus) => updateStatus(rpcInput)
      );
    },
    markThreadObserved(input) {
      const rpcInput: Omit<ObserveMessageCommentThreadInput, 'projectId'> = {
        sessionId: input.sessionId,
        threadId: input.threadId,
        observer: input.observer,
        provenance: input.provenance,
      };
      return callProjectDataCommentRpc(
        env,
        input.projectId,
        'markMessageCommentThreadObserved',
        (markObserved) => markObserved(rpcInput)
      );
    },
    recordDirectiveDelivery(input) {
      const rpcInput: Omit<RecordMessageCommentDirectiveInput, 'projectId'> = {
        sessionId: input.sessionId,
        threadId: input.threadId,
        delivery: input.delivery,
        sentByUserId: input.sentByUserId,
        sentAt: input.sentAt,
      };
      return callProjectDataCommentRpc(
        env,
        input.projectId,
        'recordMessageCommentDirectiveDelivery',
        (recordDelivery) => recordDelivery(rpcInput)
      );
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
    sourceMessage: { quote: string | null } | null;
  },
>(thread: T, config: MessageCommentConfig): T {
  return {
    ...thread,
    body: normalizeCommentBody(thread.body, config),
    anchor: {
      ...thread.anchor,
      quote: normalizeCommentQuote(thread.anchor.quote, config),
    },
    sourceMessage: thread.sourceMessage
      ? {
          ...thread.sourceMessage,
          quote: normalizeCommentQuote(thread.sourceMessage.quote, config),
        }
      : null,
  };
}

export function boundCommentThread(
  thread: MessageCommentThread,
  config: MessageCommentConfig
): MessageCommentThread {
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
  return {
    kind: 'agent',
    id: tokenData.agentSessionId || tokenData.workspaceId || tokenData.taskId || 'agent',
    displayName: 'SAM agent',
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

export function buildCommentDirectiveDeliveryId(threadId: string): string {
  return `comment-directive-${threadId}`;
}

export interface SendMessageCommentDirectiveInput {
  env: Env;
  storage: MessageCommentStorageAdapter;
  projectId: string;
  sessionId: string;
  threadId: string;
  humanUserId: string;
  now?: number;
}

export interface SendMessageCommentDirectiveResult {
  accepted: boolean;
  deliveryId: string;
  messageId: string;
  thread: MessageCommentThread;
  duplicate: boolean;
}

export async function sendMessageCommentDirective(
  input: SendMessageCommentDirectiveInput
): Promise<SendMessageCommentDirectiveResult> {
  const durableConfig = resolveDurableExecutionConfig(input.env);
  if (!durableConfig.deliveryEnabled) {
    throw new MessageCommentServiceError(
      'conflict',
      'Durable prompt delivery is disabled for comment directives'
    );
  }

  const thread = await input.storage.getThread({
    projectId: input.projectId,
    sessionId: input.sessionId,
    threadId: input.threadId,
  });
  if (!thread) {
    throw new MessageCommentServiceError('not_found', 'Comment thread not found');
  }
  if (thread.sessionId !== input.sessionId) {
    throw new MessageCommentServiceError(
      'forbidden',
      'Comment thread belongs to a different session'
    );
  }
  if (thread.status === 'resolved') {
    throw new MessageCommentServiceError('conflict', 'Resolved comment threads cannot be sent');
  }

  const config = getMessageCommentConfig(input.env);
  const deliveryId = buildCommentDirectiveDeliveryId(thread.id);
  const content = buildDirectivePrompt(thread, config);
  const accepted = await projectDataService.acceptPromptDelivery(input.env, input.projectId, {
    deliveryId,
    targetSessionId: input.sessionId,
    displayContent: content,
    deliveryContent: content,
    sourceTaskId: thread.taskId,
    senderType: 'human',
    senderId: input.humanUserId,
    messageClass: 'deliver',
    sourceKind: 'comment_directive',
    ttlMs: durableConfig.ttlMs,
    metadata: {
      commentThreadId: thread.id,
      sourceMessageId: thread.anchor.messageId,
      quote: thread.anchor.quote,
      author: {
        kind: thread.author.kind,
        displayName: thread.author.displayName,
      },
    },
  });

  const sentAt = input.now ?? Date.now();
  const delivery: MessageCommentDirectiveState = {
    deliveryId: accepted.message.id,
    deliveryState: accepted.message.deliveryState,
    promptMessageId: accepted.message.promptMessageId ?? accepted.transcriptMessageId,
    acceptedAt: accepted.message.acceptedAt ?? null,
    ackedAt: accepted.message.ackedAt ?? null,
  };
  const recordedThread =
    (await input.storage.recordDirectiveDelivery({
      projectId: input.projectId,
      sessionId: input.sessionId,
      threadId: thread.id,
      delivery,
      sentByUserId: input.humanUserId,
      sentAt,
    })) ?? thread;

  return {
    accepted: true,
    deliveryId: accepted.message.id,
    messageId: accepted.transcriptMessageId,
    thread: recordedThread,
    duplicate: !accepted.transcriptInserted,
  };
}

function buildDirectivePrompt(thread: MessageCommentThread, config: MessageCommentConfig): string {
  const author = thread.author.displayName || `${thread.author.kind}:${thread.author.id}`;
  const quote = normalizeCommentQuote(
    thread.anchor.quote ?? thread.sourceMessage?.quote ?? null,
    config
  );
  const body = normalizeCommentBody(thread.body, config);
  const sections = [
    'SAM comment directive',
    `Comment ID: ${thread.id}`,
    `Source message ID: ${thread.anchor.messageId}`,
    `Author: ${author}`,
    quote ? `Quoted context:\n${quote}` : null,
    `Feedback:\n${body}`,
  ].filter((section): section is string => Boolean(section));
  return sections.join('\n\n').slice(0, config.directiveContextMaxLength);
}

function redactSensitiveText(value: string): string {
  return value
    .replace(/\b(Bearer)\s+[A-Za-z0-9._~+/=-]{12,}/gi, '$1 [redacted]')
    .replace(/\b(token|api[_-]?key|secret|password)\s*[:=]\s*[^\s'"`<>]{8,}/gi, '$1=[redacted]')
    .replace(/\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{20,}\b/g, '[redacted]')
    .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, '[redacted]')
    .replace(/\bsk-[A-Za-z0-9_-]{20,}\b/g, '[redacted]');
}

export function assertCommentStatus(value: string): MessageCommentThreadStatus | 'all' | null {
  if (value === 'open' || value === 'sent' || value === 'resolved' || value === 'all') {
    return value;
  }
  return null;
}
