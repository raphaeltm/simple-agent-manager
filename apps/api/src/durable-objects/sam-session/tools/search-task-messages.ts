/**
 * SAM search_task_messages tool — search chat messages across project sessions.
 *
 * Allows SAM to search through the full message history of tasks within a project,
 * providing the same search capability that workspace agents have via the MCP
 * search_messages tool but at the orchestrator level.
 */
import type { Env } from '../../../env';
import * as projectDataService from '../../../services/project-data';
import type { AnthropicToolDef, ToolContext } from '../types';
import { resolveProjectWithOwnership } from './helpers';

/** Default search result limit. Override via SAM_TASK_MESSAGE_SEARCH_LIMIT. */
const DEFAULT_LIMIT = 10;
/** Max search result limit. Override via SAM_TASK_MESSAGE_SEARCH_MAX_LIMIT. */
const DEFAULT_MAX_LIMIT = 50;

const VALID_ROLES = ['user', 'assistant', 'system', 'tool', 'thinking', 'plan'];

export const searchTaskMessagesDef: AnthropicToolDef = {
  name: 'search_task_messages',
  description:
    'Search through chat messages in a project\'s task sessions. ' +
    'Use this to find specific discussions, decisions, or outputs from past or current tasks. ' +
    'Supports filtering by task ID, session ID, and message roles.',
  input_schema: {
    type: 'object',
    properties: {
      projectId: {
        type: 'string',
        description: 'The project ID to search messages in.',
      },
      query: {
        type: 'string',
        description: 'Search query — keywords or phrases to find in messages.',
      },
      taskId: {
        type: 'string',
        description: 'Optional: filter results to messages from a specific task\'s session.',
      },
      sessionId: {
        type: 'string',
        description: 'Optional: filter results to a specific session ID.',
      },
      roles: {
        type: 'array',
        items: { type: 'string', enum: VALID_ROLES },
        description: 'Optional: filter by message roles (e.g. ["assistant"]).',
      },
      limit: {
        type: 'number',
        description: `Max results to return. Defaults to ${DEFAULT_LIMIT}, max ${DEFAULT_MAX_LIMIT}.`,
      },
    },
    required: ['projectId', 'query'],
  },
};

export async function searchTaskMessages(
  input: {
    projectId: string;
    query: string;
    taskId?: string;
    sessionId?: string;
    roles?: string[];
    limit?: number;
  },
  ctx: ToolContext,
): Promise<unknown> {
  if (!input.projectId?.trim()) {
    return { error: 'projectId is required.' };
  }
  if (!input.query?.trim()) {
    return { error: 'query is required.' };
  }
  if (input.query.trim().length < 2) {
    return { error: 'query must be at least 2 characters.' };
  }

  const env = ctx.env as unknown as Env;

  // Verify ownership
  const project = await resolveProjectWithOwnership(input.projectId.trim(), ctx);
  if (!project) {
    return { error: 'Project not found or not owned by you.' };
  }

  // Resolve sessionId from taskId if provided
  let sessionId = input.sessionId?.trim() || null;
  if (input.taskId?.trim() && !sessionId) {
    // Find the session associated with this task
    const sessions = await projectDataService.listSessions(
      env,
      project.id,
      null, // any status
      1,
      0,
      input.taskId.trim(),
    );
    const firstSession = sessions.sessions[0];
    if (firstSession) {
      sessionId = firstSession.id as string;
    }
    // If no session found for this task, the search will return no results
    // which is correct behavior
  }

  // Validate roles
  const roles = input.roles?.filter((r) => VALID_ROLES.includes(r)) ?? null;

  // Resolve limits
  const maxLimit = Number(env.SAM_TASK_MESSAGE_SEARCH_MAX_LIMIT) || DEFAULT_MAX_LIMIT;
  const defaultLimit = Number(env.SAM_TASK_MESSAGE_SEARCH_LIMIT) || DEFAULT_LIMIT;
  const limit = Math.min(Math.max(1, Math.round(input.limit || defaultLimit)), maxLimit);

  const results = await projectDataService.searchMessages(
    env,
    project.id,
    input.query.trim(),
    sessionId,
    roles,
    limit,
  );

  return {
    results: results.map((r) => ({
      messageId: r.id,
      sessionId: r.sessionId,
      sessionTopic: r.sessionTopic,
      sessionTaskId: r.sessionTaskId,
      role: r.role,
      snippet: r.snippet,
      createdAt: r.createdAt,
    })),
    count: results.length,
    query: input.query.trim(),
    projectId: project.id,
  };
}
