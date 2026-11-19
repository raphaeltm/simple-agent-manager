/**
 * Workflow run reads for the project Automation → Workflows pages.
 *
 * Mounted at /api/projects/:projectId/workflows. Any active project member with `task:read`
 * can read every run in the project, as with tasks and chats; only the owner's agent can start
 * runs (MCP `start_workflow_run`). There are no write routes: the engine has no pause, retry or
 * cancel. Middleware is per route (rule 06) so it cannot leak to sibling `/api/projects` routers.
 */
import { isWorkflowRunStatus } from '@simple-agent-manager/shared';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { requireRouteParam } from '../lib/route-helpers';
import { getAuth, requireApproved, requireAuth } from '../middleware/auth';
import { errors } from '../middleware/error';
import { listWorkflowRuns, workflowRunListLimit } from '../services/workflow-run-list';
import { loadWorkflowRun, toWorkflowRunDetail } from '../services/workflow-run-read';
import { requireProjectTaskRead } from './task-project-auth';

const workflowRoutes = new Hono<{ Bindings: Env }>();

workflowRoutes.get('/', requireAuth(), requireApproved(), async (c) => {
  const projectId = requireRouteParam(c, 'projectId');
  await requireProjectTaskRead(drizzle(c.env.DATABASE, { schema }), projectId, getAuth(c).user.id);
  const status = c.req.query('status') || null;
  if (status !== null && !isWorkflowRunStatus(status))
    throw errors.badRequest('status must be active, completed or needs_attention');
  const limit = c.req.query('limit');
  return c.json(
    await listWorkflowRuns(c.env, projectId, {
      status,
      cursor: c.req.query('cursor') || null,
      limit: workflowRunListLimit(limit ? Number(limit) : null),
    })
  );
});

workflowRoutes.get('/:runId', requireAuth(), requireApproved(), async (c) => {
  const projectId = requireRouteParam(c, 'projectId');
  const runId = requireRouteParam(c, 'runId');
  await requireProjectTaskRead(drizzle(c.env.DATABASE, { schema }), projectId, getAuth(c).user.id);
  const loaded = await loadWorkflowRun(c.env, { projectId, runId });
  // Same answer for a missing run and another project's run.
  if (!loaded) throw errors.notFound('Workflow run');
  return c.json({ run: await toWorkflowRunDetail(c.env, loaded) });
});

export { workflowRoutes };
