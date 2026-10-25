import {
  formatMessageCursor,
  type MessageCursor,
  parseMessageCursor,
} from '@simple-agent-manager/shared';

import { type MessageRole, VALID_MESSAGE_ROLES, validateRoles } from '../lib/message-roles';
import { AppError } from '../middleware/error';
import { connectorPendingInteractions } from '../services/connector-agent-answer';
import { groupTokensIntoMessages } from '../services/message-groups';
import * as projectDataService from '../services/project-data';
import { describeRootSearchCoverage } from '../services/project-data-search-coverage';
import { requireSessionWriter } from '../services/session-access';
import { pendingAttention } from './attention-core';
import { readChatMessages, searchExcerpts } from './chat-transcript';
import { operationLink } from './connector-read-core';
import { OperationError } from './errors';
import { clampOperationNumber, getPlatformOperationLimits } from './limits';
import { responseBytes, resultByteBudget } from './response-budget';
import type { OperationContext } from './types';

export { groupTokensIntoMessages, type TokenRow } from '../services/message-groups';

function rolesOrThrow(input: unknown, defaults?: MessageRole[]) {
  const result = validateRoles(input, defaults);
  if (!result.valid) {
    throw new OperationError(
      'invalid_input',
      `Invalid roles: ${result.invalid.join(', ')}. Valid roles: ${VALID_MESSAGE_ROLES.join(', ')}`
    );
  }
  return result.roles;
}

/** Whole-message reads return SAM's own notices too: they explain gaps and recoveries. */
const MESSAGE_UNIT_DEFAULT_ROLES: MessageRole[] = ['user', 'assistant', 'system'];

interface ReadChatInput {
  projectId: string;
  sessionId: string;
  limit?: number;
  roles?: string[];
  cursor?: string;
  includeToolPayloads?: boolean;
  response_format?: 'concise' | 'detailed';
  unit?: 'messages' | 'rows';
}

/**
 * What the chat is waiting on a person for: ACP permission/form/URL requests and attention markers
 * (questions agents ask with `request_human_input`). Only people who can answer see them.
 */
async function writerPendingRequests(
  ctx: OperationContext,
  projectId: string,
  sessionId: string,
  createdByUserId: unknown
) {
  let writer = createdByUserId === ctx.actor.userId;
  if (!writer) {
    try {
      await requireSessionWriter(ctx.env, projectId, sessionId, ctx.actor.userId, {
        action: 'read pending agent requests',
      });
      writer = true;
    } catch (error) {
      if (!(error instanceof AppError) || error.statusCode !== 403) throw error;
    }
  }
  if (!writer) return {};
  const [pendingInteractions, attention] = await Promise.all([
    connectorPendingInteractions(ctx.env, projectId, sessionId),
    pendingAttention(ctx.env, projectId, sessionId),
  ]);
  return {
    pendingInteractions,
    pendingAttention: attention.items,
    ...(attention.available ? {} : { pendingAttentionUnavailable: true }),
  };
}

/**
 * Stored transcript rows, the historical paging unit. Workspace agents keep exactly this shape;
 * apps get it with `unit: 'rows'` for diagnostics.
 */
async function readStoredRows(
  ctx: OperationContext,
  input: ReadChatInput,
  sessionId: string,
  before: MessageCursor | null
) {
  const limits = getPlatformOperationLimits(ctx.env);
  const requestedLimit = typeof input.limit === 'number' ? input.limit : limits.messageListLimit;
  const limit = clampOperationNumber(requestedLimit, 1, limits.messageListMax, 'limit');
  const roles = rolesOrThrow(
    input.roles ?? (input.includeToolPayloads ? [...VALID_MESSAGE_ROLES] : undefined)
  );
  const connector = ctx.actor.via !== 'workspace-agent';
  const page = await projectDataService.getMessages(
    ctx.env,
    input.projectId,
    sessionId,
    connector ? limit + 1 : limit,
    before,
    null,
    connector ? undefined : roles
  );
  const lookbehind = connector && page.messages.length > limit ? page.messages[0] : undefined;
  const messages = connector ? page.messages.slice(-limit) : page.messages;
  const hasMore = page.hasMore || !!lookbehind;
  const tokens = messages.map((message: Record<string, unknown>) => ({
    id: message.id as string,
    role: message.role as string,
    content: message.content as string,
    createdAt: message.createdAt as number,
  }));
  const grouped = groupTokensIntoMessages(tokens);
  const result = grouped
    .filter((message) => !connector || roles.includes(message.role as (typeof roles)[number]))
    .map((message) => {
      if (!connector) return message;
      const first = message.id === grouped[0]?.id;
      const last = message.id === grouped[grouped.length - 1]?.id;
      const groupable = ['assistant', 'tool', 'thinking'].includes(message.role);
      const partialBefore =
        first && groupable && hasMore && (!lookbehind || lookbehind.role === message.role);
      // The cursor excludes the newer page; its adjacent role is not available here.
      const mayContinueInNewerPage = last && groupable && !!before;
      const truncated =
        input.response_format !== 'detailed' &&
        message.content.length > limits.taskDetailMessageSnippetLength;
      return {
        ...message,
        content: truncated
          ? message.content.slice(0, limits.taskDetailMessageSnippetLength)
          : message.content,
        truncated,
        partialBefore,
        mayContinueInNewerPage,
      };
    });
  if (connector) result.reverse();
  const oldest = messages[0];
  return {
    ...(connector
      ? {
          paginationUnit: 'stored_rows' as const,
          nextCursor:
            hasMore &&
            oldest &&
            typeof oldest.createdAt === 'number' &&
            typeof oldest.sequence === 'number' &&
            typeof oldest.id === 'string'
              ? formatMessageCursor({
                  createdAt: oldest.createdAt,
                  sequence: oldest.sequence,
                  id: oldest.id,
                })
              : null,
        }
      : {}),
    messages: result,
    messageCount: result.length,
    hasMore,
  };
}

export async function readChat(ctx: OperationContext, input: ReadChatInput) {
  const sessionId = typeof input.sessionId === 'string' ? input.sessionId.trim() : '';
  if (!sessionId) throw new OperationError('invalid_input', 'sessionId is required');
  const before = input.cursor ? parseMessageCursor(input.cursor) : null;
  if (input.cursor && !before) throw new OperationError('invalid_input', 'Invalid message cursor');
  const session = await projectDataService.getSession(ctx.env, input.projectId, sessionId);
  if (!session) throw new OperationError('not_found', 'Session not found in this project');
  if (ctx.actor.via === 'workspace-agent') {
    return {
      sessionId,
      topic: session.topic,
      taskId: session.taskId,
      ...(await readStoredRows(ctx, input, sessionId, before)),
    };
  }
  const common = {
    // The session was found in this authorized project's own Durable Object.
    projectId: input.projectId,
    link: operationLink(ctx, input.projectId, sessionId),
    untrustedContent: true,
    sessionId,
    topic: session.topic,
    taskId: session.taskId,
  };
  const [pending, page] = await Promise.all([
    writerPendingRequests(ctx, input.projectId, sessionId, session.createdByUserId),
    input.unit === 'rows'
      ? readStoredRows(ctx, input, sessionId, before)
      : readChatMessages(ctx, {
          projectId: input.projectId,
          sessionId,
          limit: input.limit,
          roles: rolesOrThrow(input.roles, MESSAGE_UNIT_DEFAULT_ROLES),
          cursor: before,
          detailed: input.response_format === 'detailed',
          includeToolTitles: input.includeToolPayloads === true,
        }),
  ]);
  return { ...common, ...pending, ...page };
}

export async function searchChats(
  ctx: OperationContext,
  input: {
    projectId: string;
    query: string;
    sessionId?: string;
    roles?: string[];
    limit?: number;
    continuation?: string;
  }
) {
  const query = typeof input.query === 'string' ? input.query.trim() : '';
  if (!query)
    throw new OperationError('invalid_input', 'query is required and must be a non-empty string');
  if (query.length < 2)
    throw new OperationError('invalid_input', 'query must be at least 2 characters');
  const limits = getPlatformOperationLimits(ctx.env);
  const sessionId = typeof input.sessionId === 'string' ? input.sessionId.trim() : null;
  const roles = rolesOrThrow(input.roles);
  const requestedLimit = typeof input.limit === 'number' ? input.limit : limits.messageSearchLimit;
  const limit = clampOperationNumber(requestedLimit, 1, limits.messageSearchMax, 'limit');
  const continuation =
    typeof input.continuation === 'string' && input.continuation.length > 0
      ? input.continuation
      : null;
  if (sessionId && continuation)
    throw new OperationError('invalid_input', 'continuation cannot be combined with sessionId');
  const search = await projectDataService.searchMessagesWithArchiveMetadata(
    ctx.env,
    input.projectId,
    query,
    sessionId,
    roles,
    limit,
    continuation
  );
  const app = ctx.actor.via !== 'workspace-agent';
  // Apps get the whole message around the first hits: a keyword hit can be a single streamed
  // chunk, so its snippet alone may be one word. Workspace agents keep the snippet-only shape.
  const context = app
    ? await searchExcerpts(ctx, input.projectId, search.query.query, search.results)
    : null;
  const build = (excerpts: readonly unknown[] | null, dropped: number) => ({
    results: search.results.map((result, index) => {
      const excerpt = excerpts ? excerpts[index] : undefined;
      return {
        ...(app
          ? {
              projectId: input.projectId,
              link: operationLink(ctx, input.projectId, result.sessionId),
            }
          : {}),
        messageId: result.id,
        sessionId: result.sessionId,
        sessionTopic: result.sessionTopic,
        sessionTaskId: result.sessionTaskId,
        role: result.role,
        snippet: result.snippet,
        createdAt: result.createdAt,
        ...(excerpt ? { excerpt } : {}),
      };
    }),
    count: search.results.length,
    ...search.query,
    archiveSearch: search.archiveSearch,
    rootSearch: search.rootSearch,
    coverageNotes: describeRootSearchCoverage(search.rootSearch),
    ...(context && excerpts
      ? {
          excerptCoverage: {
            resultsWithExcerpts: excerpts.filter(Boolean).length,
            excerptLimit: context.excerptLimit,
            ...(dropped > 0 ? { droppedToFitResponse: dropped } : {}),
            readMore:
              'sam_chat_message_get with a result excerpt messageId reads the whole message.',
          },
        }
      : {}),
  });
  if (!context) return build(null, 0);
  // Excerpts are extra context: when a page with all of them would not fit one response, the
  // last ones are left out (and counted) rather than failing the search.
  const excerpts: unknown[] = [...context.excerpts];
  const budget = resultByteBudget(ctx.env);
  let dropped = 0;
  let result = build(excerpts, dropped);
  for (let index = excerpts.length - 1; index >= 0 && responseBytes(result) > budget; index -= 1) {
    if (!excerpts[index]) continue;
    excerpts[index] = null;
    dropped += 1;
    result = build(excerpts, dropped);
  }
  return result;
}
