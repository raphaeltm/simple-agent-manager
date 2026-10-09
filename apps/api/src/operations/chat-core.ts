import { formatMessageCursor, parseMessageCursor } from '@simple-agent-manager/shared';

import { VALID_MESSAGE_ROLES, validateRoles } from '../lib/message-roles';
import { connectorPendingInteractions } from '../services/connector-agent-answer';
import { groupTokensIntoMessages } from '../services/message-groups';
import * as projectDataService from '../services/project-data';
import { describeRootSearchCoverage } from '../services/project-data-search-coverage';
import { OperationError } from './errors';
import { clampOperationNumber, getPlatformOperationLimits } from './limits';
import type { OperationContext } from './types';

export { groupTokensIntoMessages, type TokenRow } from '../services/message-groups';

function rolesOrThrow(input: unknown) {
  const result = validateRoles(input);
  if (!result.valid) {
    throw new OperationError(
      'invalid_input',
      `Invalid roles: ${result.invalid.join(', ')}. Valid roles: ${VALID_MESSAGE_ROLES.join(', ')}`
    );
  }
  return result.roles;
}

export async function readChat(
  ctx: OperationContext,
  input: {
    projectId: string;
    sessionId: string;
    limit?: number;
    roles?: string[];
    cursor?: string;
    includeToolPayloads?: boolean;
    response_format?: 'concise' | 'detailed';
  }
) {
  const sessionId = typeof input.sessionId === 'string' ? input.sessionId.trim() : '';
  if (!sessionId) throw new OperationError('invalid_input', 'sessionId is required');
  const limits = getPlatformOperationLimits(ctx.env);
  const requestedLimit = typeof input.limit === 'number' ? input.limit : limits.messageListLimit;
  const limit = clampOperationNumber(requestedLimit, 1, limits.messageListMax, 'limit');
  const roles = rolesOrThrow(
    input.roles ?? (input.includeToolPayloads ? [...VALID_MESSAGE_ROLES] : undefined)
  );
  const before = input.cursor ? parseMessageCursor(input.cursor) : null;
  if (input.cursor && !before) throw new OperationError('invalid_input', 'Invalid message cursor');
  const session = await projectDataService.getSession(ctx.env, input.projectId, sessionId);
  if (!session) throw new OperationError('not_found', 'Session not found in this project');
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
    ...(ctx.actor.via !== 'workspace-agent'
      ? {
          untrustedContent: true,
          paginationUnit: 'stored_rows',
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
    sessionId,
    topic: session.topic,
    taskId: session.taskId,
    ...(connector && session.createdByUserId === ctx.actor.userId
      ? {
          pendingInteractions: await connectorPendingInteractions(
            ctx.env,
            input.projectId,
            sessionId
          ),
        }
      : {}),
    messages: result,
    messageCount: result.length,
    hasMore,
  };
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
  return {
    results: search.results.map((result) => ({
      messageId: result.id,
      sessionId: result.sessionId,
      sessionTopic: result.sessionTopic,
      sessionTaskId: result.sessionTaskId,
      role: result.role,
      snippet: result.snippet,
      createdAt: result.createdAt,
    })),
    count: search.results.length,
    ...search.query,
    archiveSearch: search.archiveSearch,
    rootSearch: search.rootSearch,
    coverageNotes: describeRootSearchCoverage(search.rootSearch),
  };
}
