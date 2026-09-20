/**
 * SAM get_resource_history tool — inspect workspace resource summaries and lazy chunk detail.
 */
import type { Env } from '../../../env';
import { getWorkspaceResourceHistory } from '../../../services/workspace-resource-history';
import type { AnthropicToolDef, ToolContext } from '../types';
import { resolveProjectWithOwnership } from './helpers';

export const getResourceHistoryDef: AnthropicToolDef = {
  name: 'get_resource_history',
  description:
    'Inspect bounded workspace resource history for a project session, task, or workspace. ' +
    'Returns a cheap summary and chunk index by default. Pass chunkId to load bounded downsampled samples and tool-span correlation for one chunk. ' +
    'Tool spans are correlation windows, not causal per-process attribution, and stored payloads omit prompts, commands, tool args/output, file paths, env, and secrets.',
  input_schema: {
    type: 'object',
    properties: {
      projectId: {
        type: 'string',
        description: 'The project ID that owns the resource history.',
      },
      sessionId: {
        type: 'string',
        description: 'Optional session scope.',
      },
      taskId: {
        type: 'string',
        description: 'Optional task scope.',
      },
      workspaceId: {
        type: 'string',
        description: 'Optional workspace scope.',
      },
      chunkId: {
        type: 'string',
        description: 'Optional resource chunk ID to load detail for.',
      },
    },
    required: ['projectId'],
  },
};

function trimOptional(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export async function getResourceHistory(
  input: {
    projectId: string;
    sessionId?: string;
    taskId?: string;
    workspaceId?: string;
    chunkId?: string;
  },
  ctx: ToolContext
): Promise<unknown> {
  const projectId = input.projectId?.trim();
  if (!projectId) {
    return { error: 'projectId is required.' };
  }
  const sessionId = trimOptional(input.sessionId);
  const taskId = trimOptional(input.taskId);
  const workspaceId = trimOptional(input.workspaceId);
  if (!sessionId && !taskId && !workspaceId) {
    return { error: 'Provide sessionId, taskId, or workspaceId.' };
  }

  const env = ctx.env as unknown as Env;
  const project = await resolveProjectWithOwnership(projectId, ctx);
  if (!project) {
    return { error: 'Project not found or not owned by you.' };
  }

  const history = await getWorkspaceResourceHistory(env, {
    projectId: project.id,
    sessionId,
    taskId,
    workspaceId,
    detailChunkId: trimOptional(input.chunkId),
  });

  return {
    scope: { projectId: project.id, sessionId, taskId, workspaceId },
    ...history,
    notes: [
      'Samples are workspace-level cgroup observations, not per-process attribution.',
      'Tool spans are timestamp correlation windows and may overlap background work.',
      'Chunk detail is returned only when chunkId is supplied; summary reads stay bounded.',
    ],
  };
}
