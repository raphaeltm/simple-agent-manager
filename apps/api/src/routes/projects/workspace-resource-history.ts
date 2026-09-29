import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';

import * as schema from '../../db/schema';
import type { Env } from '../../env';
import { getUserId } from '../../middleware/auth';
import { errors } from '../../middleware/error';
import { requireProjectAccess } from '../../middleware/project-auth';
import { getWorkspaceResourceHistory } from '../../services/workspace-resource-history';
import {
  getSessionResourceTimeline,
  getSessionResourceTimelineChunk,
} from '../../services/workspace-resource-timeline';

const projectResourceHistoryRoutes = new Hono<{ Bindings: Env }>();

function optionalDetailChunkId(value: string | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > 256) {
    throw errors.badRequest('chunkId is too long');
  }
  return trimmed;
}

async function requireAccess(env: Env, projectId: string, userId: string): Promise<void> {
  const db = drizzle(env.DATABASE, { schema });
  await requireProjectAccess(db, projectId, userId);
}

projectResourceHistoryRoutes.get('/:id/sessions/:sessionId/resource-history', async (c) => {
  const projectId = c.req.param('id');
  const sessionId = c.req.param('sessionId');
  await requireAccess(c.env, projectId, getUserId(c));
  return c.json(
    await getWorkspaceResourceHistory(c.env, {
      projectId,
      sessionId,
      detailChunkId: optionalDetailChunkId(c.req.query('chunkId')),
    })
  );
});

projectResourceHistoryRoutes.get('/:id/sessions/:sessionId/resource-timeline', async (c) => {
  const projectId = c.req.param('id');
  const sessionId = c.req.param('sessionId');
  await requireAccess(c.env, projectId, getUserId(c));
  return c.json(await getSessionResourceTimeline(c.env, { projectId, sessionId }));
});

projectResourceHistoryRoutes.get(
  '/:id/sessions/:sessionId/resource-timeline/chunks/:chunkId',
  async (c) => {
    const projectId = c.req.param('id');
    const sessionId = c.req.param('sessionId');
    const chunkId = optionalDetailChunkId(c.req.param('chunkId'));
    if (!chunkId) throw errors.badRequest('chunkId is required');
    await requireAccess(c.env, projectId, getUserId(c));
    return c.json(await getSessionResourceTimelineChunk(c.env, { projectId, sessionId, chunkId }));
  }
);

projectResourceHistoryRoutes.get('/:id/tasks/:taskId/resource-history', async (c) => {
  const projectId = c.req.param('id');
  const taskId = c.req.param('taskId');
  await requireAccess(c.env, projectId, getUserId(c));
  return c.json(
    await getWorkspaceResourceHistory(c.env, {
      projectId,
      taskId,
      detailChunkId: optionalDetailChunkId(c.req.query('chunkId')),
    })
  );
});

projectResourceHistoryRoutes.get('/:id/workspaces/:workspaceId/resource-history', async (c) => {
  const projectId = c.req.param('id');
  const workspaceId = c.req.param('workspaceId');
  await requireAccess(c.env, projectId, getUserId(c));
  return c.json(
    await getWorkspaceResourceHistory(c.env, {
      projectId,
      workspaceId,
      detailChunkId: optionalDetailChunkId(c.req.query('chunkId')),
    })
  );
});

export { projectResourceHistoryRoutes };
