/**
 * SAM get_archived_tool_payloads tool — retrieve ProjectData tool payloads
 * archived from Durable Object SQLite into private R2.
 */
import type { Env } from '../../../env';
import { operationDeps } from '../../../operation-ports';
import { readArchivedToolPayloads } from '../../../operations/workspace-history';
import type { AnthropicToolDef, ToolContext } from '../types';
import { resolveProjectWithOwnership } from './helpers';

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
        description: `Max archived payloads to return. Defaults to 10, max 50.`,
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

  const read = await readArchivedToolPayloads(operationDeps(env), {
    projectId: project.id,
    messageId: messageId || null,
    sessionId: sessionId || null,
    startTime,
    endTime,
    requestedLimit: input.limit || null,
  });
  if (!read.ok) return { error: 'Session not found in this project.' };
  return read.result;
}
