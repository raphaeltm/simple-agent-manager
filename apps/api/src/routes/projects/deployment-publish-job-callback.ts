import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import type { InferOutput } from 'valibot';
import * as v from 'valibot';

import { createCloudflareBuildPorts } from '../../app-deployment-ports/cloudflare-builder';
import * as schema from '../../db/schema';
import type { Env } from '../../env';
import { log } from '../../lib/logger';
import { parseWithSchema, readRequestJsonRecord } from '../../lib/runtime-validation';
import { errors } from '../../middleware/error';
import {
  appendDeploymentPublishJobEvent,
  PUBLISH_JOB_TERMINAL_STATUSES,
} from '../../services/deployment-publish-jobs';
import { recordDeploymentPublishJobLifecycleEventBestEffort } from '../../services/project-lifecycle-events';
import { verifyPublishCallback } from './_publish-callback-auth';
import { publishJobSpecRoute } from './publish-job-spec';

const deploymentPublishJobCallbackRoute = new Hono<{ Bindings: Env }>();
deploymentPublishJobCallbackRoute.route('/', publishJobSpecRoute);

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
  const {
    projectId,
    workspaceId,
    userId,
    db,
    assertCurrent,
    job: authenticatedJob,
  } = await verifyPublishCallback(
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
  if (event.terminal && (!status || !PUBLISH_JOB_TERMINAL_STATUSES.has(status))) {
    throw errors.badRequest('Terminal publish job event requires a terminal status');
  }
  if (
    !optionalString(event.releaseId) &&
    (event.releaseVersion !== undefined || event.releaseStatus !== undefined)
  ) {
    throw errors.badRequest('Release metadata requires releaseId');
  }
  if (authenticatedJob && event.releaseId && event.releaseId !== authenticatedJob.releaseId)
    throw errors.forbidden('Event release must already be linked to this job');
  const terminal = event.terminal === true || PUBLISH_JOB_TERMINAL_STATUSES.has(status ?? '');
  const currentStep = optionalString(event.currentStep) ?? optionalString(event.step);
  await assertCurrent();
  const accepted = await appendDeploymentPublishJobEvent(db, {
    publishJobId,
    expectedAttempt: authenticatedJob?.attempt,
    expectedExecutor: authenticatedJob ? 'cloudflare' : undefined,
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
    terminal,
    releaseId: optionalString(event.releaseId) ?? undefined,
    releaseVersion: optionalNumber(event.releaseVersion) ?? undefined,
    releaseStatus: optionalString(event.releaseStatus) ?? undefined,
    errorMessage: optionalString(event.errorMessage),
    errorCode: optionalString(event.errorCode),
    retryable: event.retryable === true,
  });

  if (accepted === false)
    throw errors.conflict('Publish job is terminal or release does not match');
  if (!authenticatedJob) await assertCurrent();
  if (
    !job.contextShadow &&
    eventType !== 'publish.job.heartbeat' &&
    status &&
    status !== job.status
  ) {
    c.executionCtx.waitUntil(
      recordDeploymentPublishJobLifecycleEventBestEffort(c.env, {
        projectId,
        publishJobId,
        environmentId: job.environmentId,
        status,
        fromStatus: job.status,
        currentStep,
        nodeId: job.nodeId,
        workspaceId,
        releaseId: optionalString(event.releaseId) ?? undefined,
        releaseVersion: optionalNumber(event.releaseVersion) ?? undefined,
        terminal,
        source: 'deployment_publish_job_callback.status',
        occurredAt: Date.now(),
      })
    );
  }

  if (!authenticatedJob) await assertCurrent();
  if (job.executor === 'cloudflare' && job.executorInstanceId && terminal)
    c.executionCtx.waitUntil(
      createCloudflareBuildPorts(c.env)
        .builder.stop(job)
        .catch(() => log.warn('cloudflare_builder.stop_pending', { publishJobId: job.id }))
    );
  return c.json({ ok: true });
});

export { deploymentPublishJobCallbackRoute };
