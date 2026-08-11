import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import type { InferOutput } from 'valibot';
import * as v from 'valibot';

import * as schema from '../../db/schema';
import type { Env } from '../../env';
import { parseWithSchema, readRequestJsonRecord } from '../../lib/runtime-validation';
import { errors } from '../../middleware/error';
import { appendDeploymentPublishJobEvent } from '../../services/deployment-publish-jobs';
import { verifyWorkspacePublishCallback } from './_callback-auth';

const deploymentPublishJobCallbackRoute = new Hono<{ Bindings: Env }>();

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function optionalNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : null;
}

/**
 * Allowlisted shape of a deployment publish job event callback body
 * (internal/publish/events.go: Event). `detail` is intentionally left
 * unvalidated here — it is a free-form diagnostic payload that
 * appendDeploymentPublishJobEvent safely JSON-serializes (falling back to a
 * placeholder note on non-serializable input), so it is read directly from
 * the raw parsed body as `unknown`, matching its consumer's `detail?:
 * unknown` parameter exactly.
 */
const publishJobEventSchema = v.object({
  eventType: v.optional(v.string()),
  message: v.optional(v.string()),
  status: v.optional(v.string()),
  currentStep: v.optional(v.string()),
  step: v.optional(v.string()),
  level: v.optional(v.string()),
  terminal: v.optional(v.boolean()),
  releaseId: v.optional(v.string()),
  releaseVersion: v.optional(v.number()),
  releaseStatus: v.optional(v.string()),
  errorMessage: v.optional(v.string()),
  errorCode: v.optional(v.string()),
  retryable: v.optional(v.boolean()),
});

deploymentPublishJobCallbackRoute.post('/:id/deployment-publish-jobs/:jobId/events', async (c) => {
  const { projectId, workspaceId, userId, db } = await verifyWorkspacePublishCallback(
    c,
    'deployment_publish_job_event',
    'Invalid token scope for deployment publish job event'
  );
  const publishJobId = c.req.param('jobId');
  const [job] = await db
    .select()
    .from(schema.deploymentPublishJobs)
    .where(
      and(
        eq(schema.deploymentPublishJobs.id, publishJobId),
        eq(schema.deploymentPublishJobs.projectId, projectId),
        eq(schema.deploymentPublishJobs.workspaceId, workspaceId),
        eq(schema.deploymentPublishJobs.requestedBy, userId)
      )
    )
    .limit(1);
  if (!job) {
    throw errors.notFound('Publish job');
  }

  let requestBody: Record<string, unknown>;
  try {
    requestBody = await readRequestJsonRecord(c.req.raw, 'deployment_publish_job_event.body');
  } catch {
    throw errors.badRequest('Invalid publish job event body');
  }

  let event: InferOutput<typeof publishJobEventSchema>;
  try {
    event = parseWithSchema(
      publishJobEventSchema,
      requestBody,
      'deployment_publish_job_event.body'
    );
  } catch {
    throw errors.badRequest('Invalid publish job event body');
  }

  const eventType = optionalString(event.eventType);
  const message = optionalString(event.message);
  if (!eventType || !message) {
    throw errors.badRequest('Publish job event requires eventType and message');
  }

  const status = optionalString(event.status) ?? undefined;
  const currentStep = optionalString(event.currentStep) ?? optionalString(event.step);
  await appendDeploymentPublishJobEvent(db, {
    publishJobId,
    projectId,
    environmentId: job.environmentId,
    nodeId: job.nodeId,
    workspaceId,
    status,
    currentStep,
    level: optionalString(event.level) ?? undefined,
    eventType,
    message,
    detail: requestBody.detail,
    terminal: event.terminal === true,
    releaseId: optionalString(event.releaseId),
    releaseVersion: optionalNumber(event.releaseVersion),
    releaseStatus: optionalString(event.releaseStatus),
    errorMessage: optionalString(event.errorMessage),
    errorCode: optionalString(event.errorCode),
    retryable: event.retryable === true,
  });

  return c.json({ ok: true });
});

export { deploymentPublishJobCallbackRoute };
