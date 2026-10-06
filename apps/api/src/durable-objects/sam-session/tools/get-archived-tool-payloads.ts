/**
 * SAM get_archived_tool_payloads tool — retrieve ProjectData tool payloads
 * archived from Durable Object SQLite into private R2.
 */
import type { Env } from '../../../env';
import * as projectDataService from '../../../services/project-data';
import type { AnthropicToolDef, ToolContext } from '../types';
import { resolveProjectWithOwnership } from './helpers';

const DEFAULT_LIMIT = 10;
const DEFAULT_MAX_LIMIT = 50;

export const getArchivedToolPayloadsDef: AnthropicToolDef = {
  name: 'get_archived_tool_payloads',
  description:
    'Retrieve archived tool-call JSON payloads for a project. Provide a messageId, sessionId, or message-created time range. Archived payloads are read from private R2 through SAM; object keys and direct URLs are not exposed.',
  input_schema: {
    type: 'object',
    properties: {
      projectId: {
        type: 'string',
        description: 'The project ID that owns the archived payloads.',
      },
      messageId: {
        type: 'string',
        description: 'Optional exact tool message ID to retrieve.',
      },
      sessionId: {
        type: 'string',
        description: 'Optional session ID to retrieve archived payloads from.',
      },
      startTime: {
        type: ['number', 'string'],
        description:
          'Optional inclusive lower bound for message created time, as epoch milliseconds or an ISO timestamp.',
      },
      endTime: {
        type: ['number', 'string'],
        description:
          'Optional inclusive upper bound for message created time, as epoch milliseconds or an ISO timestamp.',
      },
      limit: {
        type: 'number',
        description: `Max archived payloads to return. Defaults to ${DEFAULT_LIMIT}, max ${DEFAULT_MAX_LIMIT}.`,
      },
    },
    required: ['projectId'],
  },
};

function parseOptionalTimestamp(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Date.parse(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export async function getArchivedToolPayloads(
  input: {
    projectId: string;
    messageId?: string;
    sessionId?: string;
    startTime?: string | number;
    endTime?: string | number;
    limit?: number;
  },
  ctx: ToolContext
): Promise<unknown> {
  if (!input.projectId?.trim()) {
    return { error: 'projectId is required.' };
  }

  const messageId = input.messageId?.trim() || '';
  const sessionId = input.sessionId?.trim() || '';
  const startTime = parseOptionalTimestamp(input.startTime);
  const endTime = parseOptionalTimestamp(input.endTime);
  if (!messageId && !sessionId && startTime === null && endTime === null) {
    return {
      error: 'Provide messageId, sessionId, startTime, or endTime to bound archive retrieval.',
    };
  }
  if (startTime !== null && endTime !== null && startTime > endTime) {
    return { error: 'startTime must be before or equal to endTime.' };
  }

  const env = ctx.env as unknown as Env;
  const project = await resolveProjectWithOwnership(input.projectId.trim(), ctx);
  if (!project) {
    return { error: 'Project not found or not owned by you.' };
  }

  if (sessionId) {
    const session = await projectDataService.getSession(env, project.id, sessionId);
    if (!session) return { error: 'Session not found in this project.' };
  }

  const maxLimit = parsePositiveInteger(env.MCP_ARCHIVED_TOOL_PAYLOAD_LIST_MAX, DEFAULT_MAX_LIMIT);
  const defaultLimit = parsePositiveInteger(
    env.MCP_ARCHIVED_TOOL_PAYLOAD_LIST_LIMIT,
    DEFAULT_LIMIT
  );
  const limit = Math.min(Math.max(1, Math.round(input.limit || defaultLimit)), maxLimit);

  return projectDataService.getArchivedToolPayloads(env, project.id, {
    ...(messageId ? { messageId } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(startTime !== null ? { startTime } : {}),
    ...(endTime !== null ? { endTime } : {}),
    limit,
  });
}
