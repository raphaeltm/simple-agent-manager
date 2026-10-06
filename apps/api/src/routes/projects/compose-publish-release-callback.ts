import {
  DEFAULT_DEPLOYMENT_SERVICE_CPU_MILLIS,
  DEFAULT_DEPLOYMENT_SERVICE_DISK_MB,
  DEFAULT_DEPLOYMENT_SERVICE_MEMORY_MB,
  type DeploymentReservationDefaults,
  parseResources,
  resolveDeploymentManifestReservation,
  type ResolvedResourceReservation,
} from '@simple-agent-manager/shared';
import { and, desc, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import type { InferOutput } from 'valibot';
import * as v from 'valibot';
import { parse as parseYaml } from 'yaml';

import * as schema from '../../db/schema';
import type { Env } from '../../env';
import { log, serializeError } from '../../lib/logger';
import { parsePositiveInt } from '../../lib/route-helpers';
import { parseWithSchema, readRequestJsonRecord } from '../../lib/runtime-validation';
import { ulid } from '../../lib/ulid';
import { AppError, errors } from '../../middleware/error';
import {
  getComposeImageArtifactMaxBytes,
  validateCompletedComposeImageArtifacts,
  validateComposeImageArtifactDescriptor,
} from '../../services/compose-image-artifacts';
import { extractComposePublishVolumeDeclarations } from '../../services/compose-publish-apply';
import { assertAgentDeploymentAllowedForProfile } from '../../services/deployment-control';
import {
  DEPLOYMENT_MODEL_RUNNER_VM_SIZE,
  resolveDeploymentPlacement,
} from '../../services/deployment-provisioning';
import {
  createMissingDeclaredVolumes,
  markDeploymentReleaseVolumeAttachFailed,
} from '../../services/deployment-volumes';
import { recordDeploymentReleaseLifecycleEventBestEffort } from '../../services/project-lifecycle-events';
import {
  DeploymentPlacementCancelledError,
  insertDeploymentReleaseWhilePlacementUnlocked,
  placeReleaseOnDeploymentNode,
  updateDeploymentEnvironmentForLatestRelease,
} from '../deployment-release-submission';
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

const composePublishPlatformSchema = v.object({
  architecture: v.optional(v.string()),
  os: v.optional(v.string()),
  variant: v.optional(v.string()),
});

const composePublishServiceSchema = v.object({
  serviceName: v.optional(v.string()),
  registryServiceName: v.optional(v.string()),
  sourceRef: v.optional(v.string()),
  localImageRef: v.optional(v.string()),
  pushedRef: v.optional(v.string()),
  digest: v.optional(v.string()),
  r2Key: v.optional(v.string()),
  sizeBytes: v.optional(v.number()),
  archiveSha256: v.optional(v.string()),
  archiveType: v.optional(v.string()),
  mediaType: v.optional(v.string()),
  platform: v.optional(composePublishPlatformSchema),
});

const composePublishSubmittedBySchema = v.object({
  taskId: v.optional(v.string()),
  agentProfileId: v.optional(v.string()),
});

/**
 * Allowlisted shape of the VM agent's compose-publish release submission
 * (internal/publish/controlplane.go: SubmitRelease / ReleaseSubmission).
 *
 * This is intentionally NOT `DeploymentManifestSchema` (@simple-agent-manager/shared)
 * — a compose-publish submission is the agent's captured `docker compose
 * publish` topology (composeYaml + pushed service image refs), a completely
 * different shape from the normalized build-on-node deployment manifest
 * (version/services-map/routes/volumes/hooks). Only the fields declared here
 * are ever read from the parsed body, and only these fields (plus
 * server-recomputed identity) are ever persisted as the stored release
 * manifest — see the explicit allowlist reconstruction below. This closes a
 * route-claim-smuggling gap where a compromised/misbehaving VM agent could
 * inject a foreign top-level field (notably `routes` — a real
 * DeploymentManifest field this submission has no legitimate reason to
 * carry) that `buildReleaseRouteDiscovery`
 * (services/deployment-routing.ts) would otherwise treat as an authoritative
 * build-on-node manifest. See .claude/rules/11-fail-fast-patterns.md and
 * .claude/rules/51-runtime-boundary-validation.md.
 */
const composePublishReleaseSubmissionSchema = v.object({
  environment: v.optional(v.string()),
  environmentId: v.optional(v.string()),
  reference: v.optional(v.string()),
  composeYaml: v.optional(v.string()),
  services: v.optional(v.array(composePublishServiceSchema)),
  submittedBy: v.optional(composePublishSubmittedBySchema),
});

type ComposePublishServiceInput = InferOutput<typeof composePublishServiceSchema>;

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

function resolveComposePublishReservation(
  composeYaml: string,
  environmentId: string,
  volumes: Record<string, { sizeHintMb?: number }>,
  defaults: DeploymentReservationDefaults
): ResolvedResourceReservation {
  let doc: unknown;
  try {
    doc = parseYaml(composeYaml);
  } catch (error) {
    throw errors.badRequest(error instanceof Error ? error.message : String(error));
  }
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) {
    throw errors.badRequest('Captured composeYaml must be a mapping');
  }
  const rawServices = (doc as Record<string, unknown>).services;
  if (typeof rawServices !== 'object' || rawServices === null || Array.isArray(rawServices)) {
    throw errors.badRequest('Captured composeYaml must include a services mapping');
  }

  const services: Record<string, { resources?: { memoryLimitMb: number; cpuLimit: number } }> = {};
  const resourceErrors: Array<{ path: string; message: string }> = [];
  for (const [serviceName, rawService] of Object.entries(rawServices)) {
    if (typeof rawService !== 'object' || rawService === null || Array.isArray(rawService)) {
      services[serviceName] = {};
      continue;
    }
    const deploy = (rawService as Record<string, unknown>).deploy;
    const resources =
      typeof deploy === 'object' && deploy !== null && !Array.isArray(deploy)
        ? parseResources(
            { resources: (deploy as Record<string, unknown>).resources },
            `services.${serviceName}`,
            resourceErrors
          )
        : undefined;
    services[serviceName] = resources ? { resources } : {};
  }
  if (resourceErrors.length > 0) {
    throw errors.badRequest(
      resourceErrors.map(({ path, message }) => `${path}: ${message}`).join('; ')
    );
  }
  return resolveDeploymentManifestReservation({ services, volumes }, environmentId, defaults);
}

composePublishReleaseCallbackRoute.post('/:id/compose-publish-release', async (c) => {
  const { projectId, workspaceId, userId, db, assertCurrent } =
    await verifyWorkspacePublishCallback(
      c,
      'compose_publish_release',
      'Invalid token scope for compose-publish release'
    );

  let submissionBody: Record<string, unknown>;
  try {
    submissionBody = await readRequestJsonRecord(c.req.raw, 'compose_publish_release.submission');
  } catch {
    throw errors.badRequest('Invalid release submission body');
  }

  let submission: InferOutput<typeof composePublishReleaseSubmissionSchema>;
  try {
    submission = parseWithSchema(
      composePublishReleaseSubmissionSchema,
      submissionBody,
      'compose_publish_release.submission'
    );
  } catch {
    throw errors.badRequest('Invalid release submission body');
  }

  const environment = cleanOptionalString(submission.environment);
  const environmentId = cleanOptionalString(submission.environmentId);
  if (!environment || !environmentId) {
    throw errors.badRequest('Release submission is missing target deployment environment');
  }

  const submittedByInput = submission.submittedBy ?? {};
  const taskId = cleanOptionalString(submittedByInput.taskId);
  const agentProfileId = cleanOptionalString(submittedByInput.agentProfileId);
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
      status: schema.deploymentEnvironments.status,
      resolvedReservationJson: schema.deploymentEnvironments.resolvedReservationJson,
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

  const composeYaml = submission.composeYaml;
  if (typeof composeYaml !== 'string' || composeYaml.trim() === '') {
    throw errors.badRequest('Release submission is missing composeYaml');
  }
  let volumeDeclarations: Record<string, { sizeHintMb?: number }> = {};
  try {
    volumeDeclarations = extractComposePublishVolumeDeclarations(composeYaml);
  } catch (err) {
    throw errors.badRequest(err instanceof Error ? err.message : String(err));
  }
  const requiresVolumes = Object.keys(volumeDeclarations).length > 0;
  const reservation = resolveComposePublishReservation(
    composeYaml,
    environmentId,
    volumeDeclarations,
    {
      cpuMillis: parsePositiveInt(
        c.env.DEPLOYMENT_DEFAULT_CPU_LIMIT_MILLIS,
        DEFAULT_DEPLOYMENT_SERVICE_CPU_MILLIS
      ),
      memoryMb: parsePositiveInt(
        c.env.DEPLOYMENT_DEFAULT_MEMORY_LIMIT_MB,
        DEFAULT_DEPLOYMENT_SERVICE_MEMORY_MB
      ),
      diskMb: parsePositiveInt(
        c.env.DEPLOYMENT_DEFAULT_ROOT_DISK_MB,
        DEFAULT_DEPLOYMENT_SERVICE_DISK_MB
      ),
    }
  );

  const services: ComposePublishServiceInput[] = submission.services ?? [];
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
      await assertCurrent();
      await validateCompletedComposeImageArtifacts(c.env, artifacts);
    } catch (err) {
      if (err instanceof AppError) throw err;
      throw errors.badRequest(err instanceof Error ? err.message : String(err));
    }
  }

  const vmSizeOverride = composeHasModelProvider(composeYaml)
    ? c.env.DEPLOYMENT_MODEL_RUNNER_VM_SIZE?.trim() || DEPLOYMENT_MODEL_RUNNER_VM_SIZE
    : undefined;
  const placement = await resolveDeploymentPlacement(userId, c.env, projectId, {
    reservation,
    vmSizeOverride,
  });
  if (!placement) {
    throw errors.badRequest(
      'No cloud provider credential found. Connect a cloud provider before deploying applications.'
    );
  }
  if (requiresVolumes && placement) {
    await assertCurrent();
    await createMissingDeclaredVolumes(db, c.env, userId, {
      environmentId,
      volumes: volumeDeclarations,
      location: placement.location,
      targetProvider: placement.provider,
    });
  }

  // SECURITY: explicit allowlist reconstruction, NOT a spread of the raw
  // request body. See composePublishReleaseSubmissionSchema doc comment above
  // — a foreign field like a top-level `routes` array must never survive into
  // the stored manifest, or a downstream consumer that keys off field
  // presence (buildReleaseRouteDiscovery) could treat it as authoritative.
  const manifestSubmission: Record<string, unknown> = {
    environment,
    environmentId,
    composeYaml,
    reference: cleanOptionalString(submission.reference),
    services: services.map((svc) => ({
      serviceName: svc.serviceName,
      registryServiceName: svc.registryServiceName,
      sourceRef: svc.sourceRef,
      localImageRef: svc.localImageRef,
      pushedRef: svc.pushedRef,
      digest: svc.digest,
      r2Key: svc.r2Key,
      sizeBytes: svc.sizeBytes,
      archiveSha256: svc.archiveSha256,
      archiveType: svc.archiveType,
      mediaType: svc.mediaType,
      platform: svc.platform,
    })),
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
  const releaseCreatedAt = new Date().toISOString();

  await assertCurrent();
  try {
    const insertedRelease = await insertDeploymentReleaseWhilePlacementUnlocked({
      db,
      env: c.env,
      values: {
        id: releaseId,
        environmentId,
        // The captured submission IS the manifest for compose-publish releases;
        // the `source` discriminator tells consumers how to interpret it.
        manifest: JSON.stringify(manifestSubmission),
        version: nextVersion,
        status: 'created',
        statusUpdatedAt: releaseCreatedAt,
        source: 'compose-publish',
        createdBy: userId,
        createdAt: releaseCreatedAt,
      },
    });
    if (!insertedRelease) {
      throw errors.conflict(
        'Another deployment placement operation is in progress. Please retry this release.'
      );
    }
    await assertCurrent();
    await updateDeploymentEnvironmentForLatestRelease({
      db,
      env: c.env,
      environmentId,
      releaseId,
      requiresVolumes,
      updatedAt: new Date().toISOString(),
    });
  } catch (err) {
    if (err instanceof AppError) throw err;
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
    reference: submission.reference ?? null,
  });

  await assertCurrent();
  c.executionCtx?.waitUntil(
    recordDeploymentReleaseLifecycleEventBestEffort(c.env, {
      projectId,
      releaseId,
      environmentId,
      status: 'created',
      version: nextVersion,
      workspaceId,
      taskId: taskId ?? null,
      source: 'compose_publish_release_callback.create',
      occurredAt: releaseCreatedAt,
    })
  );

  // Admit this release through the same reservation-aware placement path used
  // by normalized manifests. Failures here must not fail the release recording
  // (the release is already durable); placement can be retried later.
  let nodeId: string | null = environmentRow.nodeId ?? null;
  try {
    nodeId = await placeReleaseOnDeploymentNode({
      db,
      env: c.env,
      envId: environmentId,
      projectId,
      userId,
      releaseId,
      requiresVolumes,
      placement,
      reservation,
      executionCtx: c.executionCtx,
      beforeExternalMutation: assertCurrent,
    });
  } catch (err) {
    if (err instanceof AppError) throw err;
    if (err instanceof DeploymentPlacementCancelledError) {
      log.info('compose_publish_release.placement_superseded', {
        projectId,
        environmentId,
        releaseId,
      });
      nodeId = environmentRow.nodeId ?? null;
    } else {
      await assertCurrent();
      await markDeploymentReleaseVolumeAttachFailed(db, environmentId, releaseId, err, c.env);
      log.error('compose_publish_release.provisioning_trigger_failed', {
        projectId,
        environmentId,
        releaseId,
        ...serializeError(err),
      });
    }
  }

  // Response shape matches the agent's Go ReleaseResult struct
  // (releaseId/version/status).
  await assertCurrent();
  return c.json({
    releaseId,
    version: nextVersion,
    status: 'created',
    nodeId,
  });
});

export { composePublishReleaseCallbackRoute };
