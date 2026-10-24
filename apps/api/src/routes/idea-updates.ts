import { drizzle } from 'drizzle-orm/d1';
import { type Context, Hono } from 'hono';
import * as v from 'valibot';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { requireRouteParam } from '../lib/route-helpers';
import { getUserId, requireApproved, requireAuth } from '../middleware/auth';
import { AppError } from '../middleware/error';
import { requireProjectAccess, requireProjectCapability } from '../middleware/project-auth';
import { OperationError, operationErrorHttpStatus } from '../operations/errors';
import { addIdeaUpdate, deleteIdeaUpdate, listIdeaUpdates } from '../operations/idea-update-core';
import type { OperationContext } from '../operations/types';
import { jsonValidator } from '../schemas';

const ideaUpdateRoutes = new Hono<{ Bindings: Env }>();

function context(c: Context<{ Bindings: Env }>): OperationContext {
  return {
    env: c.env,
    requestId: '',
    actor: { userId: getUserId(c), via: 'web', scopes: new Set(['sam.read', 'sam.write']) },
  };
}

async function run<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof OperationError) {
      throw new AppError(operationErrorHttpStatus(error), error.code.toUpperCase(), error.message);
    }
    throw error;
  }
}

ideaUpdateRoutes.get('/:ideaId/updates', requireAuth(), requireApproved(), async (c) => {
  const projectId = requireRouteParam(c, 'projectId');
  await requireProjectAccess(drizzle(c.env.DATABASE, { schema }), projectId, getUserId(c));
  return c.json(
    await run(() =>
      listIdeaUpdates(context(c), {
        projectId,
        ideaId: requireRouteParam(c, 'ideaId'),
        cursor: c.req.query('cursor'),
      })
    )
  );
});
ideaUpdateRoutes.post(
  '/:ideaId/updates',
  requireAuth(),
  requireApproved(),
  jsonValidator(v.object({ body: v.string(), quote: v.optional(v.string()) })),
  async (c) => {
    const projectId = requireRouteParam(c, 'projectId');
    await requireProjectCapability(
      drizzle(c.env.DATABASE, { schema }),
      projectId,
      getUserId(c),
      'task:write'
    );
    const body = c.req.valid('json');
    return c.json(
      await run(() =>
        addIdeaUpdate(context(c), {
          projectId,
          ideaId: requireRouteParam(c, 'ideaId'),
          body: body.body,
          quote: body.quote,
        })
      ),
      201
    );
  }
);
ideaUpdateRoutes.delete(
  '/:ideaId/updates/:updateId',
  requireAuth(),
  requireApproved(),
  async (c) => {
    const projectId = requireRouteParam(c, 'projectId');
    await requireProjectCapability(
      drizzle(c.env.DATABASE, { schema }),
      projectId,
      getUserId(c),
      'task:write'
    );
    return c.json(
      await run(() =>
        deleteIdeaUpdate(context(c), {
          projectId,
          ideaId: requireRouteParam(c, 'ideaId'),
          updateId: requireRouteParam(c, 'updateId'),
        })
      )
    );
  }
);

export { ideaUpdateRoutes };
