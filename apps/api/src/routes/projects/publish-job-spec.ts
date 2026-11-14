import { createBuildContextDownload } from '@simple-agent-manager/app-deployment';
import { Hono } from 'hono';

import type { Env } from '../../env';
import { extractBearerToken } from '../../lib/auth-helpers';
import { errors } from '../../middleware/error';
import { resolveAdminSetting } from '../../services/admin-settings';
import { loadDeploymentBuildInterpolationEnv } from '../../services/deployment-environment-config';
import { verifyPublishJobToken } from '../../services/publish-job-token';

/** Mounted with the existing job callback router, before session-cookie auth. */
export const publishJobSpecRoute = new Hono<{ Bindings: Env }>();
publishJobSpecRoute.get('/:id/deployment-publish-jobs/:jobId/spec', async (c) => {
  const { db, job } = await verifyPublishJobToken(
    c.env,
    extractBearerToken(c.req.header('Authorization'))
  );
  if (job.projectId !== c.req.param('id') || job.id !== c.req.param('jobId'))
    throw errors.forbidden('Publish job route identity mismatch');
  if (
    !job.contextR2Key ||
    !job.contextSha256 ||
    !job.contextBytes ||
    !job.executorDeadlineAt ||
    !job.executorInstanceId
  )
    throw errors.conflict('Job has no verified admitted context');
  const interpolation = await loadDeploymentBuildInterpolationEnv(db, job.environmentId);
  const expiresIn = Math.min(
    Number(await resolveAdminSetting(c.env, 'deployments.buildContextUploadTtlSeconds')),
    Math.floor((Date.parse(job.executorDeadlineAt) - Date.now()) / 1000)
  );
  if (expiresIn < 1) throw errors.gone('Publish job deadline elapsed');
  const contextUrl = await createBuildContextDownload(c.env, job.contextR2Key, expiresIn);
  await verifyPublishJobToken(c.env, extractBearerToken(c.req.header('Authorization')));
  return c.json({
    jobId: job.id,
    attempt: job.attempt,
    environment: job.environmentName,
    environmentId: job.environmentId,
    reference: job.reference,
    agentProfileId: job.agentProfileId,
    taskId: job.taskId ?? '',
    contextUrl,
    contextBytes: job.contextBytes,
    contextSha256: job.contextSha256,
    projectName: job.contextProjectName,
    maxBytes: Number(await resolveAdminSetting(c.env, 'deployments.buildContextMaxBytes')),
    buildInterpolationEnv: interpolation.values,
    secretInterpolationKeys: interpolation.secretKeys,
    daemonReadyTimeoutMs: Number(
      await resolveAdminSetting(c.env, 'deployments.builderDaemonReadyTimeoutMs')
    ),
    heartbeatIntervalMs: Number(
      await resolveAdminSetting(c.env, 'deployments.builderHeartbeatIntervalMs')
    ),
  });
});
