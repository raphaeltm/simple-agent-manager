import type { Context } from 'hono';
import { Hono } from 'hono';
import type { InferOutput } from 'valibot';
import * as v from 'valibot';

import type { Env } from '../../env';
import { log } from '../../lib/logger';
import { parseWithSchema, readRequestJsonRecord } from '../../lib/runtime-validation';
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

const artifactPolicyBodySchema = v.object({
  environment: v.optional(v.string()),
  environmentId: v.optional(v.string()),
  agentProfileId: v.optional(v.string()),
});

const artifactPlatformSchema = v.object({
  architecture: v.optional(v.string()),
  os: v.optional(v.string()),
  variant: v.optional(v.string()),
});

/** Matches ComposeImageArtifactRequest (services/compose-image-artifacts.ts)
 * exactly. serviceName/sourceRef are required here (not deferred to
 * createComposeImageArtifactUploads's internal check) so a missing field
 * fails closed with 400 instead of the plain Error createComposeImageArtifactUploads
 * throws today escaping uncaught to a 500. */
const artifactInitServiceSchema = v.object({
  serviceName: v.string(),
  sourceRef: v.string(),
  localImageRef: v.optional(v.string()),
  platform: v.optional(artifactPlatformSchema),
});

const artifactInitRequestSchema = v.object({
  services: v.optional(v.array(artifactInitServiceSchema)),
});

/**
 * Loosely-typed shape for /complete — validateComposeImageArtifactDescriptor
 * is the authoritative field-level validator (required-ness, digest format,
 * size, R2-key scoping, with specific per-field error messages) and is
 * already invoked in a try/catch below, so this schema only needs to
 * guarantee each array entry is a plain object with well-typed fields.
 */
const artifactCompleteItemSchema = v.object({
  serviceName: v.optional(v.string()),
  sourceRef: v.optional(v.string()),
  localImageRef: v.optional(v.string()),
  r2Key: v.optional(v.string()),
  sizeBytes: v.optional(v.number()),
  archiveSha256: v.optional(v.string()),
  archiveType: v.optional(v.string()),
  mediaType: v.optional(v.string()),
  platform: v.optional(artifactPlatformSchema),
});

const artifactCompleteRequestSchema = v.object({
  artifacts: v.optional(v.array(artifactCompleteItemSchema)),
});

async function verifyArtifactPolicy(c: Context<{ Bindings: Env }>, logPrefix: string) {
  const verified = await verifyWorkspacePublishCallback(
    c,
    logPrefix,
    'Invalid token scope for compose image artifact upload'
  );

  let requestBody: Record<string, unknown>;
  try {
    requestBody = await readRequestJsonRecord(c.req.raw, `${logPrefix}.body`);
  } catch {
    throw errors.badRequest('Artifact request body is required');
  }

  let policyFields: InferOutput<typeof artifactPolicyBodySchema>;
  try {
    policyFields = parseWithSchema(artifactPolicyBodySchema, requestBody, `${logPrefix}.policy`);
  } catch {
    throw errors.badRequest('Artifact request body is required');
  }

  const environment = cleanOptionalString(policyFields.environment);
  const environmentId = cleanOptionalString(policyFields.environmentId);
  const agentProfileId = cleanOptionalString(policyFields.agentProfileId);
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

  let initRequest: InferOutput<typeof artifactInitRequestSchema>;
  try {
    initRequest = parseWithSchema(
      artifactInitRequestSchema,
      verified.requestBody,
      'compose_image_artifact_init.services'
    );
  } catch {
    throw errors.badRequest('Artifact upload init requires at least one service');
  }
  const services: ComposeImageArtifactRequest[] = initRequest.services ?? [];
  if (services.length === 0) {
    throw errors.badRequest('Artifact upload init requires at least one service');
  }
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

  let completeRequest: InferOutput<typeof artifactCompleteRequestSchema>;
  try {
    completeRequest = parseWithSchema(
      artifactCompleteRequestSchema,
      verified.requestBody,
      'compose_image_artifact_complete.artifacts'
    );
  } catch {
    throw errors.badRequest('Artifact completion requires at least one artifact');
  }
  const artifactsRaw = completeRequest.artifacts ?? [];
  if (artifactsRaw.length === 0) {
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
