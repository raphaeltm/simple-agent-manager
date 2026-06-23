import { and, desc, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { parse as parseYaml } from 'yaml';

import * as schema from '../../db/schema';
import type { Env } from '../../env';
import { log, serializeError } from '../../lib/logger';
import { ulid } from '../../lib/ulid';
import { errors } from '../../middleware/error';
import {
  getComposeImageArtifactMaxBytes,
  validateCompletedComposeImageArtifacts,
  validateComposeImageArtifactDescriptor,
} from '../../services/compose-image-artifacts';
import { assertAgentDeploymentAllowedForProfile } from '../../services/deployment-control';
import {
  DEPLOYMENT_MODEL_RUNNER_VM_SIZE,
  provisionDeploymentNode,
} from '../../services/deployment-provisioning';
import { verifyWorkspacePublishCallback } from './_callback-auth';

/**
 * Compose-publish release ingestion callback — mounted BEFORE projectsRoutes in
 * index.ts to avoid the blanket requireAuth() middleware that validates browser
 * session cookies (not callback JWTs).
 *
 * Auth: Callback JWT via Bearer token, verified inline with verifyCallbackToken().
 * Accepts workspace-scoped tokens (the VM agent's per-workspace callback token).
 *
 * The VM agent's publish orchestrator (internal/publish/controlplane.go:
 * SubmitRelease) calls this endpoint after capturing a `docker compose publish`
 * artifact and re-pushing the built service images into the project namespace.
 * It records the captured topology + image digests as a deployment release with
 * source = 'compose-publish'.
 *
 * Like the build-on-node deploy path (deployment-release-submission.ts), this
 * path provisions a deployment node for the environment when one is not already
 * linked, so the captured release actually rolls out. When the captured compose
 * declares Docker Model Runner `provider:` services, the node is sized up
 * (medium) so the runner daemon + model weights fit.
 *
 * Releases require a NOT-NULL environmentId. The MCP handler policy-checks the
 * named target environment, then the vm-agent carries that environment name/id
 * through this callback so release recording cannot drift to a different
 * enabled environment.
 *
 * See: .claude/rules/06-api-patterns.md (Hono middleware scoping)
 * See: .claude/rules/34-vm-agent-callback-auth.md
 */
const composePublishReleaseCallbackRoute = new Hono<{ Bindings: Env }>();

interface ServiceReleaseInput {
  serviceName?: unknown;
  sourceRef?: unknown;
  localImageRef?: unknown;
  pushedRef?: unknown;
  digest?: unknown;
  r2Key?: unknown;
  sizeBytes?: unknown;
  archiveSha256?: unknown;
  archiveType?: unknown;
  mediaType?: unknown;
  platform?: unknown;
}

interface SubmittedByInput {
  taskId?: unknown;
  agentProfileId?: unknown;
}

function cleanOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

/**
 * Detect whether the captured compose declares any Docker Model Runner
 * `provider:` service. Best-effort — a parse failure returns false (the apply
 * path re-parses and surfaces real errors there); detection only affects node
 * sizing, never release recording.
 */
function composeHasModelProvider(composeYaml: string): boolean {
  let doc: unknown;
  try {
    doc = parseYaml(composeYaml);
  } catch {
    return false;
  }
  if (typeof doc !== 'object' || doc === null) return false;
  const services = (doc as { services?: unknown }).services;
  if (typeof services !== 'object' || services === null) return false;
  for (const svc of Object.values(services as Record<string, unknown>)) {
    if (typeof svc === 'object' && svc !== null && 'provider' in svc) {
      return true;
    }
  }
  return false;
}

composePublishReleaseCallbackRoute.post('/:id/compose-publish-release', async (c) => {
  const { projectId, workspaceId, userId, db } = await verifyWorkspacePublishCallback(
    c,
    'compose_publish_release',
    'Invalid token scope for compose-publish release'
  );

  const submission = await c.req.json().catch(() => null);
  if (!submission || typeof submission !== 'object') {
    throw errors.badRequest('Invalid release submission body');
  }
  const submissionBody = submission as Record<string, unknown>;

  const environment = cleanOptionalString(submissionBody.environment);
  const environmentId = cleanOptionalString(submissionBody.environmentId);
  if (!environment || !environmentId) {
    throw errors.badRequest('Release submission is missing target deployment environment');
  }

  const submittedByRaw = submissionBody.submittedBy;
  const submittedBy =
    submittedByRaw && typeof submittedByRaw === 'object'
      ? (submittedByRaw as SubmittedByInput)
      : {};
  const taskId = cleanOptionalString(submittedBy.taskId);
  const agentProfileId = cleanOptionalString(submittedBy.agentProfileId);
  if (!agentProfileId) {
    throw errors.badRequest('Release submission is missing agentProfileId');
  }

  const policyResult = await assertAgentDeploymentAllowedForProfile(
    db,
    projectId,
    environment,
    agentProfileId,
    { taskId: taskId ?? null }
  );
  if ('error' in policyResult || policyResult.environmentId !== environmentId) {
    log.warn('compose_publish_release.environment_denied', {
      projectId,
      workspaceId,
      environment,
      environmentId,
      agentProfileId,
      action: 'rejected',
    });
    throw errors.forbidden(
      'error' in policyResult
        ? policyResult.error
        : `Deployment environment '${environment}' did not match the submitted environment id.`
    );
  }

  const envRows = await db
    .select({
      nodeId: schema.deploymentEnvironments.nodeId,
    })
    .from(schema.deploymentEnvironments)
    .where(
      and(
        eq(schema.deploymentEnvironments.id, environmentId),
        eq(schema.deploymentEnvironments.projectId, projectId)
      )
    )
    .limit(1);

  const environmentRow = envRows[0];
  if (!environmentRow) {
    throw errors.conflict(
      `Deployment environment '${environment}' changed while recording the release. Please retry.`
    );
  }

  const composeYaml = submissionBody.composeYaml;
  if (typeof composeYaml !== 'string' || composeYaml.trim() === '') {
    throw errors.badRequest('Release submission is missing composeYaml');
  }

  const servicesRaw = submissionBody.services;
  const services: ServiceReleaseInput[] = Array.isArray(servicesRaw) ? servicesRaw : [];
  if (services.length === 0) {
    throw errors.badRequest('Release submission must include at least one service');
  }
  const maxArtifactBytes = getComposeImageArtifactMaxBytes(c.env);
  const artifactServices = services.filter((svc) => cleanOptionalString(svc.r2Key));
  if (artifactServices.length > 0) {
    try {
      const artifacts = artifactServices.map((svc) =>
        validateComposeImageArtifactDescriptor(svc, {
          projectId,
          workspaceId,
          environmentId,
          maxBytes: maxArtifactBytes,
        })
      );
      await validateCompletedComposeImageArtifacts(c.env, artifacts);
    } catch (err) {
      throw errors.badRequest(err instanceof Error ? err.message : String(err));
    }
  }

  const manifestSubmission: Record<string, unknown> = {
    ...submissionBody,
    environment,
    environmentId,
    submittedBy: {
      userId,
      workspaceId,
      taskId,
      agentProfileId,
    },
  };

  // Compute the next version for this environment. The unique (environmentId,
  // version) index makes a concurrent double-publish fail the insert rather than
  // silently overwrite — acceptable: the agent retries publish.
  const latestRows = await db
    .select({ version: schema.deploymentReleases.version })
    .from(schema.deploymentReleases)
    .where(eq(schema.deploymentReleases.environmentId, environmentId))
    .orderBy(desc(schema.deploymentReleases.version))
    .limit(1);
  const nextVersion = (latestRows[0]?.version ?? 0) + 1;

  const releaseId = ulid();

  try {
    await db.insert(schema.deploymentReleases).values({
      id: releaseId,
      environmentId,
      // The captured submission IS the manifest for compose-publish releases;
      // the `source` discriminator tells consumers how to interpret it.
      manifest: JSON.stringify(manifestSubmission),
      version: nextVersion,
      status: 'created',
      source: 'compose-publish',
      createdBy: userId,
    });
  } catch (err) {
    const internalMessage = err instanceof Error ? err.message : String(err);
    log.error('compose_publish_release.insert_failed', {
      projectId,
      environmentId,
      version: nextVersion,
      workspaceId,
      error: internalMessage,
    });
    throw errors.internal('Failed to record compose-publish release. Please try again later.');
  }

  log.info('compose_publish_release.recorded', {
    projectId,
    environmentId,
    releaseId,
    version: nextVersion,
    serviceCount: services.length,
    reference: submissionBody.reference ?? null,
  });

  // Provision a deployment node for this environment if one is not already
  // linked, so the captured release rolls out. Failures here must NOT fail the
  // release recording (the release is already durable); the node can be
  // provisioned on the next release or via the deploy verb.
  let nodeId: string | null = environmentRow.nodeId ?? null;
  try {
    if (!nodeId) {
      const vmSizeOverride = composeHasModelProvider(composeYaml)
        ? c.env.DEPLOYMENT_MODEL_RUNNER_VM_SIZE?.trim() || DEPLOYMENT_MODEL_RUNNER_VM_SIZE
        : undefined;

      const result = await provisionDeploymentNode(environmentId, projectId, userId, c.env, {
        vmSizeOverride,
      });
      if (result) {
        nodeId = result.nodeId;
        c.executionCtx?.waitUntil(result.provisioningPromise);
        log.info('compose_publish_release.provisioning_triggered', {
          projectId,
          environmentId,
          releaseId,
          nodeId,
          vmSizeOverride: vmSizeOverride ?? null,
        });
      }
    }
  } catch (err) {
    log.error('compose_publish_release.provisioning_trigger_failed', {
      projectId,
      environmentId,
      releaseId,
      ...serializeError(err),
    });
  }

  // Response shape matches the agent's Go ReleaseResult struct
  // (releaseId/version/status).
  return c.json({
    releaseId,
    version: nextVersion,
    status: 'created',
    nodeId,
  });
});

export { composePublishReleaseCallbackRoute };
