import { VALID_MESSAGE_ROLES, validateRoles } from '../lib/message-roles';
import * as projectDataService from '../services/project-data';
import { describeRootSearchCoverage } from '../services/project-data-search-coverage';
import { OperationError } from './errors';
import { clampOperationNumber, getPlatformOperationLimits } from './limits';
import type { OperationContext } from './types';

export interface TokenRow {
  id: string;
  role: string;
  content: string;
  createdAt: number;
}

const GROUPABLE_ROLES = new Set(['assistant', 'tool', 'thinking']);
export function groupTokensIntoMessages(tokens: TokenRow[]): TokenRow[] {
  const grouped: TokenRow[] = [];
  for (const token of tokens) {
    const last = grouped[grouped.length - 1];
    if (last && last.role === token.role && GROUPABLE_ROLES.has(token.role)) {
      last.content += token.content;
    } else {
      grouped.push({ ...token });
    }
  }
  return grouped;
}

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
  input: { projectId: string; sessionId: string; limit?: number; roles?: string[] }
) {
  const sessionId = typeof input.sessionId === 'string' ? input.sessionId.trim() : '';
  if (!sessionId) throw new OperationError('invalid_input', 'sessionId is required');
  const limits = getPlatformOperationLimits(ctx.env);
  const requestedLimit = typeof input.limit === 'number' ? input.limit : limits.messageListLimit;
  const limit = clampOperationNumber(requestedLimit, 1, limits.messageListMax, 'limit');
  const roles = rolesOrThrow(input.roles);
  const session = await projectDataService.getSession(ctx.env, input.projectId, sessionId);
  if (!session) throw new OperationError('not_found', 'Session not found in this project');
  const { messages, hasMore } = await projectDataService.getMessages(
    ctx.env,
    input.projectId,
    sessionId,
    limit,
    null,
    null,
    roles
  );
  const tokens = messages.map((message: Record<string, unknown>) => ({
    id: message.id as string,
    role: message.role as string,
    content: message.content as string,
    createdAt: message.createdAt as number,
  }));
  const result = groupTokensIntoMessages(tokens);
  return {
    sessionId,
    topic: session.topic,
    taskId: session.taskId,
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
