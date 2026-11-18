/**
 * GET /api/projects/:projectId/overview — the Project Overview page's one aggregated read
 * (Inbox slice F1). A thin adapter over the shared `projectOverviewGet` operation, which owns
 * the membership check, the queries and their limits (policy 5cb362e8).
 *
 * After the response, the generated brief (inbox slice I) is brought up to date in the
 * background (`refreshProjectBriefIfDue`): the page shows the stored brief at once and never
 * waits on the model. The refresh runs only after the read authorized the viewer.
 */
import {
  getProjectBriefSettings,
  projectOverviewGet,
  toOperationHttpError,
} from '@simple-agent-manager/operations';
import { Hono } from 'hono';

import type { Env } from '../env';
import { log } from '../lib/logger';
import { parsePositiveInt, requireRouteParam } from '../lib/route-helpers';
import { getUserId, requireApproved, requireAuth } from '../middleware/auth';
import { webOperationContext } from '../operation-ports';
import { refreshProjectBriefIfDue } from '../services/project-brief/refresh';

export const projectOverviewRoutes = new Hono<{ Bindings: Env }>();

projectOverviewRoutes.get('/', requireAuth(), requireApproved(), async (c) => {
  const userId = getUserId(c);
  const projectId = requireRouteParam(c, 'projectId');
  const runningLimit = parsePositiveInt(c.req.query('runningLimit'), 0) || undefined;
  const recentLimit = parsePositiveInt(c.req.query('recentLimit'), 0) || undefined;
  const ctx = webOperationContext(c, userId);
  let result;
  try {
    result = await projectOverviewGet(ctx, { projectId, runningLimit, recentLimit });
  } catch (error) {
    throw toOperationHttpError(error);
  }

  const refresh = getProjectBriefSettings(ctx).then((settings) =>
    refreshProjectBriefIfDue({ env: c.env, projectId: result.projectId, settings })
  );
  try {
    c.executionCtx.waitUntil(refresh);
  } catch {
    // No ExecutionContext (some test harnesses): the refresh never throws, so it may run
    // detached; it is simply not kept alive past the response.
    log.warn('project_brief.refresh_detached', { projectId });
  }
  return c.json(result);
});
