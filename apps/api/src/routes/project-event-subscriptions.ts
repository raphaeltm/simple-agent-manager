/** Member controls mounted after the projects authentication middleware. */
import { isJsonRecord, type ProjectEventSubscriptionState } from '@simple-agent-manager/shared';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';

import * as schema from '../db/schema';
import { resolveProjectEventLimits } from '../durable-objects/project-data/project-events-limits';
import type { Env } from '../env';
import { readBoundedRequestBody, RequestBodyTooLargeError } from '../lib/bounded-request-body';
import { requireRouteParam } from '../lib/route-helpers';
import { getUserId } from '../middleware/auth';
import { AppError, errors } from '../middleware/error';
import { requireProjectCapability } from '../middleware/project-auth';
import * as projectData from '../services/project-data';

export const projectEventSubscriptionRoutes = new Hono<{ Bindings: Env }>();

function rethrowEventError(error: unknown): never {
  if (error instanceof projectData.ProjectEventNotFoundError)
    throw errors.notFound('Event subscription');
  if (error instanceof projectData.ProjectEventValidationError)
    throw errors.badRequest(error.message);
  if (error instanceof projectData.ProjectEventLimitExceededError) {
    throw new AppError(429, 'EVENT_CAPACITY', error.message);
  }
  if (error instanceof RequestBodyTooLargeError) {
    throw new AppError(413, 'PAYLOAD_TOO_LARGE', error.message);
  }
  throw error;
}

function stateFromQuery(value: string | undefined): ProjectEventSubscriptionState | 'any' {
  if (value === undefined) return 'active';
  if (value === 'active' || value === 'cancelled' || value === 'expired' || value === 'any')
    return value;
  throw errors.badRequest('state must be active, cancelled, expired, or any');
}

projectEventSubscriptionRoutes.get('/', async (c) => {
  const projectId = requireRouteParam(c, 'projectId');
  const db = drizzle(c.env.DATABASE, { schema });
  await requireProjectCapability(db, projectId, getUserId(c), 'task:read');
  const allowed = new Set(['state', 'limit', 'sessionId']);
  if (Object.keys(c.req.query()).some((key) => !allowed.has(key))) {
    throw errors.badRequest('Unsupported subscription query parameter');
  }
  const rawLimit = c.req.query('limit');
  const sessionId = c.req.query('sessionId');
  if (sessionId !== undefined && sessionId.trim() === '') {
    throw errors.badRequest('sessionId must be non-empty');
  }
  const limit = rawLimit === undefined ? undefined : Number(rawLimit);
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit <= 0)) {
    throw errors.badRequest('limit must be a positive integer');
  }
  try {
    return c.json(
      await projectData.listProjectEventSubscriptions(c.env, projectId, {
        state: stateFromQuery(c.req.query('state')),
        limit,
        targetSessionId: sessionId,
      })
    );
  } catch (error) {
    rethrowEventError(error);
  }
});

projectEventSubscriptionRoutes.get('/:subscriptionId/deliveries', async (c) => {
  const projectId = requireRouteParam(c, 'projectId');
  const userId = getUserId(c);
  const db = drizzle(c.env.DATABASE, { schema });
  await requireProjectCapability(db, projectId, userId, 'task:read');
  if (Object.keys(c.req.query()).some((key) => key !== 'limit')) {
    throw errors.badRequest('Only limit may be supplied for delivery inspection');
  }
  const rawLimit = c.req.query('limit');
  const limit = rawLimit === undefined ? undefined : Number(rawLimit);
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit <= 0)) {
    throw errors.badRequest('limit must be a positive integer');
  }
  try {
    const subscriptionId = requireRouteParam(c, 'subscriptionId');
    const subscription = await projectData.getProjectEventSubscription(c.env, projectId, {
      subscriptionId,
    });
    if (!subscription) throw errors.notFound('Event subscription');
    const result = await projectData.listProjectEventDeliveryBatches(c.env, projectId, {
      subscriptionId,
      limit,
    });
    await requireProjectCapability(db, projectId, userId, 'task:read');
    return c.json({
      deliveries: result.batches.map(
        ({
          id,
          state,
          deliveryChannel,
          deliveredVia,
          requestedDelivery,
          resolvedDelivery,
          createdAt,
          updatedAt,
          deliveredAt,
          ackedAt,
          terminalAt,
          terminalReason,
        }) => ({
          id,
          state,
          deliveryChannel,
          deliveredVia,
          requestedDelivery,
          resolvedDelivery,
          createdAt,
          updatedAt,
          deliveredAt,
          ackedAt,
          terminalAt,
          terminalReason,
        })
      ),
      hasMore: result.hasMore,
    });
  } catch (error) {
    rethrowEventError(error);
  }
});

projectEventSubscriptionRoutes.get('/:subscriptionId', async (c) => {
  const projectId = requireRouteParam(c, 'projectId');
  const db = drizzle(c.env.DATABASE, { schema });
  await requireProjectCapability(db, projectId, getUserId(c), 'task:read');
  try {
    const subscription = await projectData.getProjectEventSubscription(c.env, projectId, {
      subscriptionId: requireRouteParam(c, 'subscriptionId'),
    });
    if (!subscription) throw errors.notFound('Event subscription');
    return c.json({ subscription });
  } catch (error) {
    rethrowEventError(error);
  }
});

projectEventSubscriptionRoutes.post('/:subscriptionId/cancel', async (c) => {
  const projectId = requireRouteParam(c, 'projectId');
  const userId = getUserId(c);
  const db = drizzle(c.env.DATABASE, { schema });
  await requireProjectCapability(db, projectId, userId, 'task:write');
  try {
    const limits = resolveProjectEventLimits(c.env);
    const bytes = await readBoundedRequestBody(c.req.raw, limits.maxMetadataBytes);
    let body: unknown;
    try {
      body = bytes.length ? JSON.parse(new TextDecoder().decode(bytes)) : {};
    } catch {
      throw errors.badRequest('Expected a JSON object');
    }
    if (!isJsonRecord(body) || Object.keys(body).some((key) => key !== 'reason')) {
      throw errors.badRequest('Only reason may be supplied when cancelling a subscription');
    }
    if (body.reason !== undefined && body.reason !== null && typeof body.reason !== 'string') {
      throw errors.badRequest('reason must be a string');
    }
    const subscriptionId = requireRouteParam(c, 'subscriptionId');
    const subscription = await projectData.getProjectEventSubscription(c.env, projectId, {
      subscriptionId,
    });
    if (!subscription) throw errors.notFound('Event subscription');
    if (subscription.owner.type !== 'agent' && subscription.owner.type !== 'human') {
      throw errors.forbidden(
        'This subscription must be managed through its owning policy or watch'
      );
    }
    // Membership can be revoked while the ProjectData lookup is in flight.
    await requireProjectCapability(db, projectId, userId, 'task:write');
    return c.json(
      await projectData.cancelProjectEventSubscription(c.env, projectId, {
        subscriptionId,
        cancelledBy: { type: 'human', id: userId },
        reason: body.reason,
      })
    );
  } catch (error) {
    rethrowEventError(error);
  }
});
