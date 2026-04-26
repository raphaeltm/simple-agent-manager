/**
 * Orchestrator REST API routes.
 *
 * Mounted at /api/projects/:projectId/orchestrator
 * Provides status, queue, and mission lifecycle endpoints.
 */
import {
  OVERRIDABLE_SCHEDULER_STATES,
  type SchedulerState,
} from '@simple-agent-manager/shared';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { getAuth, requireApproved, requireAuth } from '../middleware/auth';
import { errors } from '../middleware/error';
import { requireOwnedProject } from '../middleware/project-auth';
import * as orchestratorService from '../services/project-orchestrator';

const orchestratorRoutes = new Hono<{ Bindings: Env }>();

orchestratorRoutes.use('/*', requireAuth(), requireApproved());

// ─── GET /status — orchestrator status ──────────────────────────────────────

orchestratorRoutes.get('/status', async (c) => {
  const auth = getAuth(c);
  const db = drizzle(c.env.DATABASE, { schema });
  const projectId = c.req.param('projectId');
  if (!projectId) throw errors.badRequest('Missing projectId');
  await requireOwnedProject(db, projectId, auth.user.id);

  const status = await orchestratorService.getOrchestratorStatus(c.env, projectId);
  return c.json(status);
});

// ─── GET /queue — scheduling queue ──────────────────────────────────────────

orchestratorRoutes.get('/queue', async (c) => {
  const auth = getAuth(c);
  const db = drizzle(c.env.DATABASE, { schema });
  const projectId = c.req.param('projectId');
  if (!projectId) throw errors.badRequest('Missing projectId');
  await requireOwnedProject(db, projectId, auth.user.id);

  const queue = await orchestratorService.getSchedulingQueue(c.env, projectId);
  return c.json({ queue });
});

// ─── POST /missions/:missionId/pause ────────────────────────────────────────

orchestratorRoutes.post('/missions/:missionId/pause', async (c) => {
  const auth = getAuth(c);
  const db = drizzle(c.env.DATABASE, { schema });
  const projectId = c.req.param('projectId');
  const missionId = c.req.param('missionId');
  if (!projectId || !missionId) throw errors.badRequest('Missing projectId or missionId');
  await requireOwnedProject(db, projectId, auth.user.id);

  const ok = await orchestratorService.pauseMission(c.env, projectId, missionId);
  if (!ok) throw errors.notFound('Mission not found or not active');
  return c.json({ success: true });
});

// ─── POST /missions/:missionId/resume ───────────────────────────────────────

orchestratorRoutes.post('/missions/:missionId/resume', async (c) => {
  const auth = getAuth(c);
  const db = drizzle(c.env.DATABASE, { schema });
  const projectId = c.req.param('projectId');
  const missionId = c.req.param('missionId');
  if (!projectId || !missionId) throw errors.badRequest('Missing projectId or missionId');
  await requireOwnedProject(db, projectId, auth.user.id);

  const ok = await orchestratorService.resumeMission(c.env, projectId, missionId);
  if (!ok) throw errors.notFound('Mission not found or not paused');
  return c.json({ success: true });
});

// ─── POST /missions/:missionId/cancel ───────────────────────────────────────

orchestratorRoutes.post('/missions/:missionId/cancel', async (c) => {
  const auth = getAuth(c);
  const db = drizzle(c.env.DATABASE, { schema });
  const projectId = c.req.param('projectId');
  const missionId = c.req.param('missionId');
  if (!projectId || !missionId) throw errors.badRequest('Missing projectId or missionId');
  await requireOwnedProject(db, projectId, auth.user.id);

  const ok = await orchestratorService.cancelMission(c.env, projectId, missionId);
  if (!ok) throw errors.notFound('Mission not found');
  return c.json({ success: true });
});

// ─── POST /tasks/:taskId/override ───────────────────────────────────────────

orchestratorRoutes.post('/tasks/:taskId/override', async (c) => {
  const auth = getAuth(c);
  const db = drizzle(c.env.DATABASE, { schema });
  const projectId = c.req.param('projectId');
  const taskId = c.req.param('taskId');
  if (!projectId || !taskId) throw errors.badRequest('Missing projectId or taskId');
  await requireOwnedProject(db, projectId, auth.user.id);

  const body = await c.req.json<{ missionId: string; newState: string; reason: string }>();
  if (!body.missionId || !body.newState || !body.reason) {
    throw errors.badRequest('Missing missionId, newState, or reason');
  }

  if (!OVERRIDABLE_SCHEDULER_STATES.includes(body.newState as SchedulerState)) {
    throw errors.badRequest(`Invalid state: ${body.newState}. Must be one of: ${OVERRIDABLE_SCHEDULER_STATES.join(', ')}`);
  }

  const ok = await orchestratorService.overrideTaskState(
    c.env, projectId, body.missionId, taskId, body.newState as SchedulerState, body.reason,
  );
  if (!ok) throw errors.notFound('Task not found');
  return c.json({ success: true });
});

export { orchestratorRoutes };
