import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';

import * as schema from '../db/schema';
import { scheduleLimits } from '../durable-objects/project-data/project-event-schedules-config';
import { ProjectScheduleNotFoundError } from '../durable-objects/project-data/project-event-schedules-storage';
import {
  ProjectEventCursorError,
  ProjectEventLimitExceededError,
  ProjectEventValidationError,
} from '../durable-objects/project-data/project-events-contracts';
import type { Env } from '../env';
import { readBoundedRequestBody, RequestBodyTooLargeError } from '../lib/bounded-request-body';
import { requireRouteParam } from '../lib/route-helpers';
import { getUserId } from '../middleware/auth';
import { AppError, errors } from '../middleware/error';
import { requireProjectCapability } from '../middleware/project-auth';
import * as projectData from '../services/project-data';

export const projectScheduleRoutes = new Hono<{ Bindings: Env }>();

export function rethrowScheduleError(error: unknown): never {
  const name = error instanceof Error ? error.name : '';
  const message = error instanceof Error ? error.message : '';
  if (
    name === 'ProjectStandingWatchNotFoundError' ||
    message.startsWith('ProjectStandingWatchNotFoundError:')
  )
    throw errors.notFound('Standing watch');
  if (
    error instanceof ProjectScheduleNotFoundError ||
    name === 'ProjectScheduleNotFoundError' ||
    message.startsWith('ProjectScheduleNotFoundError:')
  )
    throw errors.notFound('Schedule');
  if (
    error instanceof ProjectEventLimitExceededError ||
    message.startsWith('ProjectEventLimitExceededError:')
  )
    throw new AppError(429, 'EVENT_CAPACITY', message);
  if (error instanceof RequestBodyTooLargeError)
    throw new AppError(413, 'PAYLOAD_TOO_LARGE', message);
  if (
    error instanceof ProjectEventValidationError ||
    error instanceof ProjectEventCursorError ||
    message.startsWith('ProjectEventValidationError:') ||
    message.startsWith('ProjectEventCursorError:')
  ) {
    if (/version conflict|idempotency conflict/i.test(message))
      throw new AppError(409, 'SCHEDULE_CONFLICT', message);
    throw errors.badRequest(message);
  }
  throw error;
}

export async function scheduleRequestBody(request: Request, env: Env): Promise<unknown> {
  // Prompt plus bounded identifiers/filter envelope; this also caps unknown fields.
  const bytes = await readBoundedRequestBody(request, scheduleLimits(env).promptBytes * 2);
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw errors.badRequest('Expected a JSON object');
  }
}

projectScheduleRoutes.onError((error, c) => {
  try {
    rethrowScheduleError(error);
  } catch (mapped) {
    if (mapped instanceof AppError) return c.json(mapped.toJSON(), mapped.statusCode as 400);
    throw mapped;
  }
});

projectScheduleRoutes.use('*', async (c, next) => {
  await requireProjectCapability(
    drizzle(c.env.DATABASE, { schema }),
    requireRouteParam(c, 'projectId'),
    getUserId(c),
    c.req.method === 'GET' ? 'task:read' : 'task:write'
  );
  try {
    await next();
  } catch (error) {
    rethrowScheduleError(error);
  }
});

projectScheduleRoutes.get('/', async (c) =>
  c.json(
    await projectData.listProjectSchedules(c.env, requireRouteParam(c, 'projectId'), {
      userId: getUserId(c),
      cursor: c.req.query('cursor'),
      sessionId: c.req.query('sessionId'),
      limit: c.req.query('limit') === undefined ? undefined : Number(c.req.query('limit')),
    })
  )
);

projectScheduleRoutes.get('/:id', async (c) => {
  const schedule = await projectData.getProjectSchedule(c.env, requireRouteParam(c, 'projectId'), {
    userId: getUserId(c),
    id: requireRouteParam(c, 'id'),
  });
  if (!schedule) throw errors.notFound('Schedule');
  return c.json({ schedule });
});

projectScheduleRoutes.post('/', async (c) =>
  c.json(
    await projectData.createProjectSchedule(c.env, requireRouteParam(c, 'projectId'), {
      userId: getUserId(c),
      creatorChatSessionId: null,
      request: await scheduleRequestBody(c.req.raw, c.env),
    }),
    201
  )
);

for (const operation of ['reschedule', 'cancel'] as const) {
  projectScheduleRoutes.post(`/:id/${operation}`, async (c) =>
    c.json(
      await projectData.mutateProjectSchedule(c.env, requireRouteParam(c, 'projectId'), {
        userId: getUserId(c),
        id: requireRouteParam(c, 'id'),
        operation,
        request: await scheduleRequestBody(c.req.raw, c.env),
      })
    )
  );
}

projectScheduleRoutes.post('/:id/reconcile', async (c) =>
  c.json(
    await projectData.reconcileProjectSchedule(c.env, requireRouteParam(c, 'projectId'), {
      userId: getUserId(c),
      id: requireRouteParam(c, 'id'),
      request: await scheduleRequestBody(c.req.raw, c.env),
    })
  )
);
