import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';

import * as schema from '../../db/schema';
import type { Env } from '../../env';
import { requireRouteParam } from '../../lib/route-helpers';
import { getUserId, requireApproved, requireAuth } from '../../middleware/auth';
import { requireProjectCapability } from '../../middleware/project-auth';
import { resumeProviderLimitTask } from '../../services/provider-limit-recovery';
import { requireProjectTaskById } from './_helpers';

export const providerLimitResumeRoutes = new Hono<{ Bindings: Env }>();
providerLimitResumeRoutes.post(
  '/:taskId/provider-limit/resume',
  requireAuth(),
  requireApproved(),
  async (c) => {
    const userId = getUserId(c);
    const projectId = requireRouteParam(c, 'projectId');
    const db = drizzle(c.env.DATABASE, { schema });
    await requireProjectCapability(db, projectId, userId, 'task:write');
    const task = await requireProjectTaskById(db, projectId, requireRouteParam(c, 'taskId'));
    return c.json(await resumeProviderLimitTask(c.env, task, userId), 202);
  }
);
