import type { Context } from 'hono';
import { Hono } from 'hono';

import type { Env } from '../../env';
import { log } from '../../lib/logger';
import { ulid } from '../../lib/ulid';
import { errors } from '../../middleware/error';
import {
  type ComposeImageArtifactRequest,
  createComposeImageArtifactUploads,
  getComposeImageArtifactMaxBytes,
  validateCompletedComposeImageArtifacts,
  validateComposeImageArtifactDescriptor,
} from '../../services/compose-image-artifacts';
import { assertAgentDeploymentAllowedForProfile } from '../../services/deployment-control';
import { verifyWorkspacePublishCallback } from './_callback-auth';

const composeImageArtifactsCallbackRoute = new Hono<{ Bindings: Env }>();

function cleanOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

async function verifyArtifactPolicy(
  c: Context<{ Bindings: Env }>,
  logPrefix: string
) {
  const verified = await verifyWorkspacePublishCallback(
    c,
    logPrefix,
    'Invalid token scope for compose image artifact upload'
  );
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== 'object') {
    throw errors.badRequest('Artifact request body is required');
  }
  const requestBody = body as Record<string, unknown>;
  const environment = cleanOptionalString(requestBody.environment);
  const environmentId = cleanOptionalString(requestBody.environmentId);
  const agentProfileId = cleanOptionalString(requestBody.agentProfileId);
  if (!environment || !environmentId || !agentProfileId) {
    throw errors.badRequest(
      'Artifact request must include environment, environmentId, and agentProfileId'
    );
  }

  const policy = await assertAgentDeploymentAllowedForProfile(
    verified.db,
    verified.projectId,
    environment,
    agentProfileId
  );
  if ('error' in policy || policy.environmentId !== environmentId) {
    log.warn(`${logPrefix}.policy_denied`, {
      projectId: verified.projectId,
      workspaceId: verified.workspaceId,
      environment,
      environmentId,
      agentProfileId,
      action: 'rejected',
    });
    throw errors.forbidden(
      'error' in policy
        ? policy.error
        : `Deployment environment '${environment}' did not match the submitted environment id.`
    );
  }

  return { ...verified, requestBody, environment, environmentId, agentProfileId };
}

composeImageArtifactsCallbackRoute.post('/:id/compose-image-artifacts/init', async (c) => {
  const verified = await verifyArtifactPolicy(c, 'compose_image_artifact_init');
  const servicesRaw = verified.requestBody.services;
  if (!Array.isArray(servicesRaw) || servicesRaw.length === 0) {
    throw errors.badRequest('Artifact upload init requires at least one service');
  }
  const services = servicesRaw as ComposeImageArtifactRequest[];
  const uploadId = ulid();

  const uploads = await createComposeImageArtifactUploads(c.env, {
    projectId: verified.projectId,
    workspaceId: verified.workspaceId,
    environmentId: verified.environmentId,
    uploadId,
    services,
  });

  log.info('compose_image_artifact_init.created', {
    projectId: verified.projectId,
    workspaceId: verified.workspaceId,
    environmentId: verified.environmentId,
    uploadId,
    serviceCount: uploads.length,
  });

  return c.json({
    uploadId,
    maxBytes: getComposeImageArtifactMaxBytes(c.env),
    uploads,
  });
});

composeImageArtifactsCallbackRoute.post('/:id/compose-image-artifacts/complete', async (c) => {
  const verified = await verifyArtifactPolicy(c, 'compose_image_artifact_complete');
  const artifactsRaw = verified.requestBody.artifacts;
  if (!Array.isArray(artifactsRaw) || artifactsRaw.length === 0) {
    throw errors.badRequest('Artifact completion requires at least one artifact');
  }
  const maxBytes = getComposeImageArtifactMaxBytes(c.env);
  let artifacts;
  try {
    artifacts = artifactsRaw.map((artifact) =>
      validateComposeImageArtifactDescriptor(artifact, {
        projectId: verified.projectId,
        workspaceId: verified.workspaceId,
        environmentId: verified.environmentId,
        maxBytes,
      })
    );
    await validateCompletedComposeImageArtifacts(c.env, artifacts);
  } catch (error) {
    throw errors.badRequest(
      error instanceof Error ? error.message : 'Artifact completion validation failed'
    );
  }

  log.info('compose_image_artifact_complete.validated', {
    projectId: verified.projectId,
    workspaceId: verified.workspaceId,
    environmentId: verified.environmentId,
    serviceCount: artifacts.length,
  });

  return c.json({ ok: true, artifacts });
});

export { composeImageArtifactsCallbackRoute };
