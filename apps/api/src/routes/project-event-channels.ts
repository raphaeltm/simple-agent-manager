import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { requireRouteParam } from '../lib/route-helpers';
import { getUserId } from '../middleware/auth';
import { errors } from '../middleware/error';
import { requireProjectCapability } from '../middleware/project-auth';
import * as projectData from '../services/project-data';

export const projectEventChannelRoutes = new Hono<{ Bindings: Env }>();

projectEventChannelRoutes.get('/:channel/history', async (c) => {
  const projectId = requireRouteParam(c, 'projectId');
  await requireProjectCapability(
    drizzle(c.env.DATABASE, { schema }),
    projectId,
    getUserId(c),
    'task:read'
  );
  const query = c.req.query();
  if (Object.keys(query).some((key) => !['cursor', 'limit'].includes(key)))
    throw errors.badRequest('Unsupported channel history parameter');
  try {
    return c.json(
      await projectData.getProjectEventChannelHistory(c.env, projectId, {
        channel: requireRouteParam(c, 'channel'),
        cursor: query.cursor,
        limit: parseLimit(query.limit),
      })
    );
  } catch (error) {
    mapChannelReadError(error);
  }
});

projectEventChannelRoutes.get('/', async (c) => {
  const projectId = requireRouteParam(c, 'projectId');
  await requireProjectCapability(
    drizzle(c.env.DATABASE, { schema }),
    projectId,
    getUserId(c),
    'task:read'
  );
  const query = c.req.query();
  if (Object.keys(query).some((key) => !['cursor', 'limit'].includes(key)))
    throw errors.badRequest('Unsupported channel catalog parameter');
  try {
    return c.json(
      await projectData.listProjectEventChannels(c.env, projectId, {
        after: query.cursor,
        limit: parseLimit(query.limit),
      })
    );
  } catch (error) {
    mapChannelReadError(error);
  }
});

function parseLimit(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit <= 0)
    throw errors.badRequest('limit must be a positive integer');
  return limit;
}

function mapChannelReadError(error: unknown): never {
  if (error instanceof projectData.ProjectEventNotFoundError) throw errors.notFound('Channel');
  if (
    error instanceof projectData.ProjectEventCursorError ||
    error instanceof projectData.ProjectEventValidationError
  ) {
    throw errors.badRequest(error.message);
  }
  throw error;
}
