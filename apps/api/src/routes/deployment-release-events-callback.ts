import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';
import type { InferOutput } from 'valibot';
import * as v from 'valibot';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { parseWithSchema, readRequestJsonRecord } from '../lib/runtime-validation';
import { errors } from '../middleware/error';
import { appendDeploymentReleaseEvent } from '../services/deployment-release-events';
import { verifyNodeCallbackAuth } from '../services/node-callback-auth';

const deploymentReleaseEventsCallbackRoute = new Hono<{ Bindings: Env }>();

/**
 * Allowlisted shape of a deployment release event callback body
 * (internal/deploy/events.go: releaseEvent). `detail` is intentionally left
 * unvalidated here — it is a free-form diagnostic payload that
 * appendDeploymentReleaseEvent safely JSON-serializes, so it is read directly
 * from the raw parsed body as `unknown`, matching its consumer's `detail?:
 * unknown` parameter exactly.
 */
const releaseEventSchema = v.object({
  environmentId: v.optional(v.string()),
  eventType: v.optional(v.string()),
  message: v.optional(v.string()),
  releaseId: v.optional(v.string()),
  releaseVersion: v.optional(v.number()),
  level: v.optional(v.string()),
  step: v.optional(v.string()),
});

deploymentReleaseEventsCallbackRoute.post('/:id/deployment-release-events', async (c) => {
  const nodeId = c.req.param('id');
  await verifyNodeCallbackAuth(c, nodeId);
  const db = drizzle(c.env.DATABASE, { schema });

  let requestBody: Record<string, unknown>;
  try {
    requestBody = await readRequestJsonRecord(c.req.raw, 'deployment_release_event.body');
  } catch {
    throw errors.badRequest('Invalid deployment release event body');
  }

  let event: InferOutput<typeof releaseEventSchema>;
  try {
    event = parseWithSchema(releaseEventSchema, requestBody, 'deployment_release_event.body');
  } catch {
    throw errors.badRequest('Invalid deployment release event body');
  }

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
    detail: requestBody.detail,
  });

  return c.json({ ok: true });
});

export { deploymentReleaseEventsCallbackRoute };
