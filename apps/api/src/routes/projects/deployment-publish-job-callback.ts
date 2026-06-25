import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';

import * as schema from '../../db/schema';
import type { Env } from '../../env';
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

deploymentPublishJobCallbackRoute.post('/:id/deployment-publish-jobs/:jobId/events', async (c) => {
  const { projectId, workspaceId, db } = await verifyWorkspacePublishCallback(
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
        eq(schema.deploymentPublishJobs.workspaceId, workspaceId)
      )
    )
    .limit(1);
  if (!job) {
    throw errors.notFound('Publish job');
  }

  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== 'object') {
    throw errors.badRequest('Invalid publish job event body');
  }
  const event = body as Record<string, unknown>;
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
    detail: event.detail,
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
