/**
 * Mission REST API routes.
 *
 * Mounted at /api/projects/:projectId/missions
 * Provides list/get for missions, state entries, and handoff packets.
 */
import {
  DEFAULT_MISSION_LIST_MAX_PAGE_SIZE,
  DEFAULT_MISSION_LIST_PAGE_SIZE,
} from '@simple-agent-manager/shared';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { getAuth, requireApproved, requireAuth } from '../middleware/auth';
import { errors } from '../middleware/error';
import { requireOwnedProject } from '../middleware/project-auth';
import * as projectDataService from '../services/project-data';

const missionRoutes = new Hono<{ Bindings: Env }>();

missionRoutes.use('/*', requireAuth(), requireApproved());

// ─── GET / — list missions for a project ────────────────────────────────────

missionRoutes.get('/', async (c) => {
  const auth = getAuth(c);
  const db = drizzle(c.env.DATABASE, { schema });
  const projectId = c.req.param('projectId');
  if (!projectId) throw errors.badRequest('Missing projectId');
  await requireOwnedProject(db, projectId, auth.user.id);

  const pageSize = Number(c.env.MISSION_LIST_PAGE_SIZE) || DEFAULT_MISSION_LIST_PAGE_SIZE;
  const maxPageSize = Number(c.env.MISSION_LIST_MAX_PAGE_SIZE) || DEFAULT_MISSION_LIST_MAX_PAGE_SIZE;
  const limit = Math.min(
    parseInt(c.req.query('limit') ?? '', 10) || pageSize,
    maxPageSize,
  );
  const offset = Math.max(parseInt(c.req.query('offset') ?? '', 10) || 0, 0);
  const status = c.req.query('status');

  let query = 'SELECT * FROM missions WHERE project_id = ?';
  const params: (string | number)[] = [projectId];

  if (status) {
    query += ' AND status = ?';
    params.push(status);
  }

  query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);

  const stmt = c.env.DATABASE.prepare(query);
  const result = await stmt.bind(...params).all();

  return c.json({
    missions: (result.results ?? []).map((row) => ({
      id: row.id,
      projectId: row.project_id,
      title: row.title,
      description: row.description,
      status: row.status,
      rootTaskId: row.root_task_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    })),
    hasMore: (result.results?.length ?? 0) === limit,
  });
});

// ─── GET /:missionId — get mission detail ───────────────────────────────────

missionRoutes.get('/:missionId', async (c) => {
  const auth = getAuth(c);
  const db = drizzle(c.env.DATABASE, { schema });
  const projectId = c.req.param('projectId');
  const missionId = c.req.param('missionId');
  if (!projectId || !missionId) throw errors.badRequest('Missing required parameters');
  await requireOwnedProject(db, projectId, auth.user.id);

  const mission = await c.env.DATABASE.prepare(
    'SELECT * FROM missions WHERE id = ? AND project_id = ?',
  ).bind(missionId, projectId).first();
  if (!mission) throw errors.notFound('Mission not found');

  // Get task summary
  const taskSummary = await c.env.DATABASE.prepare(
    `SELECT status, COUNT(*) as cnt FROM tasks WHERE mission_id = ? GROUP BY status`,
  ).bind(missionId).all();

  const tasks: Record<string, number> = {};
  for (const row of taskSummary.results ?? []) {
    tasks[row.status as string] = row.cnt as number;
  }

  return c.json({
    mission: {
      id: mission.id,
      projectId: mission.project_id,
      title: mission.title,
      description: mission.description,
      status: mission.status,
      rootTaskId: mission.root_task_id,
      budgetConfig: mission.budget_config ? JSON.parse(mission.budget_config as string) : null,
      taskSummary: tasks,
      createdAt: mission.created_at,
      updatedAt: mission.updated_at,
    },
  });
});

// ─── GET /:missionId/state — get mission state entries ───────────────��──────

missionRoutes.get('/:missionId/state', async (c) => {
  const auth = getAuth(c);
  const db = drizzle(c.env.DATABASE, { schema });
  const projectId = c.req.param('projectId');
  const missionId = c.req.param('missionId');
  if (!projectId || !missionId) throw errors.badRequest('Missing required parameters');
  await requireOwnedProject(db, projectId, auth.user.id);

  // Verify mission belongs to project
  const mission = await c.env.DATABASE.prepare(
    'SELECT id FROM missions WHERE id = ? AND project_id = ?',
  ).bind(missionId, projectId).first();
  if (!mission) throw errors.notFound('Mission not found');

  const entryType = c.req.query('entryType') ?? null;
  const entries = await projectDataService.getMissionStateEntries(c.env, projectId, missionId, entryType);

  return c.json({ entries });
});

// ─── GET /:missionId/handoffs — get handoff packets ─────────────────────────

missionRoutes.get('/:missionId/handoffs', async (c) => {
  const auth = getAuth(c);
  const db = drizzle(c.env.DATABASE, { schema });
  const projectId = c.req.param('projectId');
  const missionId = c.req.param('missionId');
  if (!projectId || !missionId) throw errors.badRequest('Missing required parameters');
  await requireOwnedProject(db, projectId, auth.user.id);

  // Verify mission belongs to project
  const mission = await c.env.DATABASE.prepare(
    'SELECT id FROM missions WHERE id = ? AND project_id = ?',
  ).bind(missionId, projectId).first();
  if (!mission) throw errors.notFound('Mission not found');

  const handoffs = await projectDataService.getHandoffPackets(c.env, projectId, missionId);

  return c.json({ handoffs });
});

export { missionRoutes };
