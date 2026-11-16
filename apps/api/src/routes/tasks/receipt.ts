/**
 * GET /api/projects/:projectId/tasks/:taskId/receipt — the Run receipt (Insights slice R).
 * A thin adapter over the shared `runReceipt` operation, which owns the membership check, the
 * project-scoped reads and their limits (policy 5cb362e8).
 */
import { runReceipt, toOperationHttpError } from '@simple-agent-manager/operations';
import { Hono } from 'hono';

import type { Env } from '../../env';
import { requireRouteParam } from '../../lib/route-helpers';
import { getUserId, requireApproved, requireAuth } from '../../middleware/auth';
import { webOperationContext } from '../../operation-ports';

export const receiptRoutes = new Hono<{ Bindings: Env }>();

receiptRoutes.get('/:taskId/receipt', requireAuth(), requireApproved(), async (c) => {
  const userId = getUserId(c);
  const projectId = requireRouteParam(c, 'projectId');
  const taskId = requireRouteParam(c, 'taskId');
  c.header('Cache-Control', 'no-store');
  try {
    return c.json(await runReceipt(webOperationContext(c, userId), { projectId, taskId }));
  } catch (error) {
    throw toOperationHttpError(error);
  }
});
