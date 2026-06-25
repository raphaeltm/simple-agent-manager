import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { errors } from '../middleware/error';
import { appendDeploymentReleaseEvent } from '../services/deployment-release-events';
import { verifyNodeCallbackAuth } from '../services/node-callback-auth';

const deploymentReleaseEventsCallbackRoute = new Hono<{ Bindings: Env }>();

deploymentReleaseEventsCallbackRoute.post('/:id/deployment-release-events', async (c) => {
  const nodeId = c.req.param('id');
  await verifyNodeCallbackAuth(c, nodeId);
  const db = drizzle(c.env.DATABASE, { schema });
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== 'object') {
    throw errors.badRequest('Invalid deployment release event body');
  }
  const event = body as Record<string, unknown>;
  const environmentId = typeof event.environmentId === 'string' ? event.environmentId.trim() : '';
  const eventType = typeof event.eventType === 'string' ? event.eventType.trim() : '';
  const message = typeof event.message === 'string' ? event.message.trim() : '';
  if (!environmentId || !eventType || !message) {
    throw errors.badRequest(
      'Deployment release event requires environmentId, eventType, and message'
    );
  }

  const [environment] = await db
    .select({
      projectId: schema.deploymentEnvironments.projectId,
      nodeId: schema.deploymentEnvironments.nodeId,
    })
    .from(schema.deploymentEnvironments)
    .where(eq(schema.deploymentEnvironments.id, environmentId))
    .limit(1);
  if (!environment || environment.nodeId !== nodeId) {
    throw errors.forbidden('Deployment environment is not assigned to this node');
  }

  await appendDeploymentReleaseEvent(db, {
    projectId: environment.projectId,
    environmentId,
    nodeId,
    releaseId: typeof event.releaseId === 'string' ? event.releaseId.trim() : null,
    releaseVersion:
      typeof event.releaseVersion === 'number' && Number.isFinite(event.releaseVersion)
        ? Math.trunc(event.releaseVersion)
        : null,
    level: typeof event.level === 'string' ? event.level : undefined,
    eventType,
    step: typeof event.step === 'string' ? event.step : null,
    message,
    detail: event.detail,
  });

  return c.json({ ok: true });
});

export { deploymentReleaseEventsCallbackRoute };
