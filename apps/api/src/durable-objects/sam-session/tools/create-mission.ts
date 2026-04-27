/**
 * SAM create_mission tool — create a mission grouping related tasks.
 *
 * Missions are top-level orchestration containers. They live in D1 and
 * are registered with the ProjectOrchestrator DO for scheduling.
 */
import { DEFAULT_MISSION_MAX_PER_PROJECT } from '@simple-agent-manager/shared';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../../../db/schema';
import type { Env } from '../../../env';
import { log } from '../../../lib/logger';
import * as orchestratorService from '../../../services/project-orchestrator';
import type { AnthropicToolDef, ToolContext } from '../types';

const DEFAULT_TITLE_MAX_LENGTH = 200;
const DEFAULT_DESCRIPTION_MAX_LENGTH = 5000;

export const createMissionDef: AnthropicToolDef = {
  name: 'create_mission',
  description:
    'Create a mission — a group of related tasks with a shared goal. ' +
    'Missions track overall progress across multiple tasks and enable dependency-based scheduling. ' +
    'After creating a mission, dispatch tasks with the missionId to associate them.',
  input_schema: {
    type: 'object',
    properties: {
      projectId: {
        type: 'string',
        description: 'The project ID to create the mission in.',
      },
      title: {
        type: 'string',
        description: 'Short title for the mission.',
      },
      description: {
        type: 'string',
        description: 'Detailed description of the mission goal and scope.',
      },
    },
    required: ['projectId', 'title'],
  },
};

export async function createMission(
  input: { projectId: string; title: string; description?: string },
  ctx: ToolContext,
): Promise<unknown> {
  const env = ctx.env as unknown as Env;
  const db = drizzle(env.DATABASE, { schema });

  if (!input.projectId?.trim()) {
    return { error: 'projectId is required.' };
  }
  if (!input.title?.trim()) {
    return { error: 'title is required.' };
  }

  const titleMaxLen = parseInt(String((env as unknown as Record<string, string>).MISSION_TITLE_MAX_LENGTH) || '', 10) || DEFAULT_TITLE_MAX_LENGTH;
  const descMaxLen = parseInt(String((env as unknown as Record<string, string>).MISSION_DESCRIPTION_MAX_LENGTH) || '', 10) || DEFAULT_DESCRIPTION_MAX_LENGTH;

  const title = input.title.trim().slice(0, titleMaxLen);
  const description = input.description?.trim().slice(0, descMaxLen) ?? null;

  // ── Verify ownership ──────────────────────────────────────────────────
  const [project] = await db
    .select({ id: schema.projects.id })
    .from(schema.projects)
    .where(
      and(
        eq(schema.projects.id, input.projectId),
        eq(schema.projects.userId, ctx.userId),
      ),
    )
    .limit(1);

  if (!project) {
    return { error: 'Project not found or not owned by you.' };
  }

  // ── Enforce per-project limit ─────────────────────────────────────────
  const maxPerProject = parseInt(String((env as unknown as Record<string, string>).MISSION_MAX_PER_PROJECT) || '', 10) || DEFAULT_MISSION_MAX_PER_PROJECT;
  const countRow = await env.DATABASE.prepare(
    'SELECT COUNT(*) as cnt FROM missions WHERE project_id = ?',
  ).bind(input.projectId).first<{ cnt: number }>();
  if (countRow && countRow.cnt >= maxPerProject) {
    return { error: `Maximum missions per project (${maxPerProject}) reached.` };
  }

  // ── Insert mission ────────────────────────────────────────────────────
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await env.DATABASE.prepare(
    `INSERT INTO missions (id, project_id, user_id, title, description, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'planning', ?, ?)`,
  ).bind(id, input.projectId, ctx.userId, title, description, now, now).run();

  // Register with orchestrator for scheduling (best-effort)
  try {
    await orchestratorService.startOrchestration(env, input.projectId, id);
  } catch (err) {
    log.warn('sam.create_mission.orchestrator_start_failed', {
      missionId: id,
      projectId: input.projectId,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  log.info('sam.create_mission.created', {
    missionId: id,
    projectId: input.projectId,
    title,
  });

  return {
    missionId: id,
    status: 'planning',
    title,
    message: `Mission created. Dispatch tasks with this missionId to associate them.`,
  };
}
