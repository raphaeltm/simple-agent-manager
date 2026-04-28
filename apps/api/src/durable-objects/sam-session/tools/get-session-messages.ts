/**
 * SAM get_session_messages tool — retrieve messages from a project chat session.
 *
 * Allows SAM to read the full conversation history of any session in a project
 * the user owns, including task execution sessions.
 */
import type { Env } from '../../../env';
import { groupTokensIntoMessages } from '../../../routes/mcp/session-tools';
import * as projectDataService from '../../../services/project-data';
import type { AnthropicToolDef, ToolContext } from '../types';
import { resolveProjectWithOwnership } from './helpers';

/** Default message limit. Override via SAM_SESSION_MESSAGES_LIMIT. */
const DEFAULT_LIMIT = 50;
/** Max message limit. Override via SAM_SESSION_MESSAGES_MAX_LIMIT. */
const DEFAULT_MAX_LIMIT = 200;

const VALID_ROLES = ['user', 'assistant', 'system', 'tool', 'thinking', 'plan'];

export const getSessionMessagesDef: AnthropicToolDef = {
  name: 'get_session_messages',
  description:
    'Get messages from a specific chat session in a project. ' +
    'Use this to read the full conversation history of a task or chat session. ' +
    'First use list_sessions to find session IDs for a project.',
  input_schema: {
    type: 'object',
    properties: {
      projectId: {
        type: 'string',
        description: 'The project ID that owns the session.',
      },
      sessionId: {
        type: 'string',
        description: 'The session ID to retrieve messages from.',
      },
      limit: {
        type: 'number',
        description: `Max messages to return. Defaults to ${DEFAULT_LIMIT}, max ${DEFAULT_MAX_LIMIT}.`,
      },
      roles: {
        type: 'array',
        items: { type: 'string', enum: VALID_ROLES },
        description: 'Filter by message roles (e.g. ["user", "assistant"]).',
      },
    },
    required: ['projectId', 'sessionId'],
  },
};

export async function getSessionMessages(
  input: { projectId: string; sessionId: string; limit?: number; roles?: string[] },
  ctx: ToolContext,
): Promise<unknown> {
  if (!input.projectId?.trim()) {
    return { error: 'projectId is required.' };
  }
  if (!input.sessionId?.trim()) {
    return { error: 'sessionId is required.' };
  }

  const env = ctx.env as unknown as Env;

  // Verify ownership
  const project = await resolveProjectWithOwnership(input.projectId.trim(), ctx);
  if (!project) {
    return { error: 'Project not found or not owned by you.' };
  }

  // Validate roles
  const roles = input.roles?.filter((r) => VALID_ROLES.includes(r));

  // Resolve limits
  const maxLimit = Number(env.SAM_SESSION_MESSAGES_MAX_LIMIT) || DEFAULT_MAX_LIMIT;
  const defaultLimit = Number(env.SAM_SESSION_MESSAGES_LIMIT) || DEFAULT_LIMIT;
  const limit = Math.min(Math.max(1, Math.round(input.limit || defaultLimit)), maxLimit);

  // Verify session belongs to this project
  const session = await projectDataService.getSession(env, project.id, input.sessionId.trim());
  if (!session) {
    return { error: 'Session not found in this project.' };
  }

  const { messages, hasMore } = await projectDataService.getMessages(
    env,
    project.id,
    input.sessionId.trim(),
    limit,
    null,
    roles,
  );

  // Group streaming tokens into logical messages
  const tokens = messages.map((m: Record<string, unknown>) => ({
    id: m.id as string,
    role: m.role as string,
    content: m.content as string,
    createdAt: m.createdAt as number,
  }));
  const grouped = groupTokensIntoMessages(tokens);

  return {
    sessionId: input.sessionId.trim(),
    topic: session.topic,
    taskId: session.taskId,
    status: session.status,
    messages: grouped,
    messageCount: grouped.length,
    hasMore,
  };
}
