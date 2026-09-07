/**
 * SAM list_sessions tool — list chat sessions for a project.
 *
 * Allows SAM to discover available sessions (task and conversation) within a
 * project, enabling further inspection via get_session_messages or search_task_messages.
 */
import type { Env } from '../../../env';
import * as projectDataService from '../../../services/project-data';
import type { AnthropicToolDef, ToolContext } from '../types';
import { resolveProjectWithOwnership } from './helpers';

/** Default session list limit. Override via SAM_SESSION_LIST_LIMIT. */
const DEFAULT_LIMIT = 20;
/** Max session list limit. Override via SAM_SESSION_LIST_MAX_LIMIT. */
const DEFAULT_MAX_LIMIT = 100;

export const listSessionsDef: AnthropicToolDef = {
  name: 'list_sessions',
  description:
    'List chat sessions for a project. Shows session IDs, topics, status, and associated task IDs. ' +
    'Use this to find sessions before reading their messages with get_session_messages.',
  input_schema: {
    type: 'object',
    properties: {
      projectId: {
        type: 'string',
        description: 'The project ID to list sessions for.',
      },
      status: {
        type: 'string',
        enum: ['running', 'stopped'],
        description: 'Optional: filter by session status.',
      },
      taskId: {
        type: 'string',
        description: 'Optional: filter to sessions associated with a specific task.',
      },
      limit: {
        type: 'number',
        description: `Max sessions to return. Defaults to ${DEFAULT_LIMIT}, max ${DEFAULT_MAX_LIMIT}.`,
      },
    },
    required: ['projectId'],
  },
};

export async function listSessions(
  input: { projectId: string; status?: string; taskId?: string; limit?: number },
  ctx: ToolContext,
): Promise<unknown> {
  if (!input.projectId?.trim()) {
    return { error: 'projectId is required.' };
  }

  const env = ctx.env as unknown as Env;

  // Verify ownership
  const project = await resolveProjectWithOwnership(input.projectId.trim(), ctx);
  if (!project) {
    return { error: 'Project not found or not owned by you.' };
  }

  // Resolve limits
  const maxLimit = Number(env.SAM_SESSION_LIST_MAX_LIMIT) || DEFAULT_MAX_LIMIT;
  const defaultLimit = Number(env.SAM_SESSION_LIST_LIMIT) || DEFAULT_LIMIT;
  const limit = Math.min(Math.max(1, Math.round(input.limit || defaultLimit)), maxLimit);

  const status = input.status || null;
  const taskId = input.taskId?.trim() || null;

  const { sessions, total } = await projectDataService.listSessions(
    env,
    project.id,
    status,
    limit,
    0,
    taskId,
  );

  return {
    sessions: sessions.map((s: Record<string, unknown>) => ({
      id: s.id,
      topic: s.topic,
      status: s.status,
      messageCount: s.messageCount,
      taskId: s.taskId,
      workspaceId: s.workspaceId,
      startedAt: s.startedAt,
      endedAt: s.endedAt,
    })),
    total,
    projectId: project.id,
  };
}
