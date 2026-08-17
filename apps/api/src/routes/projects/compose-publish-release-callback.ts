import { and, desc, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import type { InferOutput } from 'valibot';
import * as v from 'valibot';
import { parse as parseYaml } from 'yaml';

import * as schema from '../../db/schema';
import type { Env } from '../../env';
import { log, serializeError } from '../../lib/logger';
import { parseWithSchema, readRequestJsonRecord } from '../../lib/runtime-validation';
import { ulid } from '../../lib/ulid';
import { errors } from '../../middleware/error';
import {
  getComposeImageArtifactMaxBytes,
  validateCompletedComposeImageArtifacts,
  validateComposeImageArtifactDescriptor,
} from '../../services/compose-image-artifacts';
import { extractComposePublishVolumeDeclarations } from '../../services/compose-publish-apply';
import { assertAgentDeploymentAllowedForProfile } from '../../services/deployment-control';
import {
  DEPLOYMENT_MODEL_RUNNER_VM_SIZE,
  provisionDeploymentNode,
  resolveDeploymentPlacement,
} from '../../services/deployment-provisioning';
import {
  attachEnvironmentVolumesToLinkedNode,
  createMissingDeclaredVolumes,
  detachEnvironmentVolumes,
  listEnvironmentVolumes,
  markDeploymentReleaseVolumeAttachFailed,
} from '../../services/deployment-volumes';
import { teardownDeploymentEnvironmentOnNode } from '../../services/node-agent';
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

composePublishReleaseCallbackRoute.post('/:id/compose-publish-release', async (c) => {
  const { projectId, workspaceId, userId, db } = await verifyWorkspacePublishCallback(
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
      await validateCompletedComposeImageArtifacts(c.env, artifacts);
    } catch (err) {
      throw errors.badRequest(err instanceof Error ? err.message : String(err));
    }
  }

  const placement = requiresVolumes
    ? await resolveDeploymentPlacement(userId, c.env, projectId)
    : null;
  if (requiresVolumes && !placement) {
    throw errors.badRequest(
      'No cloud provider credential found. Connect a cloud provider before deploying volumes.'
    );
  }
  if (requiresVolumes && placement) {
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

  try {
    await db.insert(schema.deploymentReleases).values({
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
    });
    await db
      .update(schema.deploymentEnvironments)
      .set({
        requiresVolumes,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(schema.deploymentEnvironments.id, environmentId));
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
    reference: submission.reference ?? null,
  });

  // Provision a deployment node for this environment if one is not already
  // linked, so the captured release rolls out. Failures here must NOT fail the
  // release recording (the release is already durable); the node can be
  // provisioned on the next release or via the deploy verb.
  let nodeId: string | null = environmentRow.nodeId ?? null;
  const shouldProvision =
    environmentRow.status !== 'stopped' && environmentRow.status !== 'stopping';
  let currentNodeMode: string | null = null;
  let currentNodeStatus: string | null = null;
  let currentNodeProviderInstanceId: string | null = null;
  if (requiresVolumes && nodeId) {
    const nodeRows = await db
      .select({
        nodeMode: schema.nodes.nodeMode,
        status: schema.nodes.status,
        providerInstanceId: schema.nodes.providerInstanceId,
      })
      .from(schema.nodes)
      .where(eq(schema.nodes.id, nodeId))
      .limit(1);
    currentNodeMode = nodeRows[0]?.nodeMode ?? null;
    currentNodeStatus = nodeRows[0]?.status ?? null;
    currentNodeProviderInstanceId = nodeRows[0]?.providerInstanceId ?? null;
  }
  if (requiresVolumes && nodeId && currentNodeMode !== 'exclusive') {
    try {
      if (currentNodeStatus === 'running') {
        await teardownDeploymentEnvironmentOnNode(nodeId, environmentId, c.env, userId);
      }
      const volumes = await listEnvironmentVolumes(db, environmentId);
      const attachedServerIds = new Set<string>();
      for (const volume of volumes) {
        if (volume.attachedServerId) {
          attachedServerIds.add(volume.attachedServerId);
        }
      }
      if (currentNodeProviderInstanceId) {
        attachedServerIds.add(currentNodeProviderInstanceId);
      }
      for (const serverId of attachedServerIds) {
        await detachEnvironmentVolumes(db, c.env, userId, environmentId, serverId);
      }
    } catch (err) {
      // Shared→exclusive migration (teardown + volume detach) failed. The
      // release was already recorded durably above, so we MUST NOT return a
      // 500 here: the VM agent treats a 5xx as a transient publish failure and
      // retries the whole submission, which inserts a SECOND release with the
      // next version number (duplicate version records). Record the
      // volume-attach failure for diagnosis and return the durable release.
      // The migration is retried via the deploy verb or the next release.
      await markDeploymentReleaseVolumeAttachFailed(db, environmentId, releaseId, err);
      log.error('compose_publish_release.shared_to_exclusive_migration_failed', {
        projectId,
        environmentId,
        releaseId,
        nodeId,
        action: 'release_recorded_migration_deferred',
        ...serializeError(err),
      });
      return c.json({
        releaseId,
        version: nextVersion,
        status: 'created',
        nodeId,
      });
    }
    await db
      .update(schema.deploymentEnvironments)
      .set({ nodeId: null, updatedAt: new Date().toISOString() })
      .where(eq(schema.deploymentEnvironments.id, environmentId));
    nodeId = null;
  }
  try {
    if (!shouldProvision) {
      log.info('compose_publish_release.provisioning_skipped_environment_stopped', {
        projectId,
        environmentId,
        releaseId,
        environmentStatus: environmentRow.status,
      });
    } else if (!nodeId) {
      const vmSizeOverride = composeHasModelProvider(composeYaml)
        ? c.env.DEPLOYMENT_MODEL_RUNNER_VM_SIZE?.trim() || DEPLOYMENT_MODEL_RUNNER_VM_SIZE
        : undefined;

      const result = await provisionDeploymentNode(environmentId, projectId, userId, c.env, {
        vmSizeOverride: placement?.vmSize ?? vmSizeOverride,
        ...(placement
          ? { providerOverride: placement.provider, vmLocationOverride: placement.location }
          : {}),
        requiresVolumes,
      });
      if (result) {
        nodeId = result.nodeId;
        const provisioningPromise = result.provisioningPromise.catch(async (err) => {
          await markDeploymentReleaseVolumeAttachFailed(db, environmentId, releaseId, err);
          throw err;
        });
        const finishPromise = requiresVolumes
          ? provisioningPromise.then(async () => {
              try {
                await attachEnvironmentVolumesToLinkedNode(db, c.env, userId, environmentId);
              } catch (err) {
                await markDeploymentReleaseVolumeAttachFailed(db, environmentId, releaseId, err);
                throw err;
              }
            })
          : provisioningPromise;
        c.executionCtx?.waitUntil(finishPromise.catch(() => undefined));
        log.info('compose_publish_release.provisioning_triggered', {
          projectId,
          environmentId,
          releaseId,
          nodeId,
          vmSizeOverride: vmSizeOverride ?? null,
        });
      }
    } else if (requiresVolumes) {
      const attachPromise = attachEnvironmentVolumesToLinkedNode(db, c.env, userId, environmentId);
      c.executionCtx?.waitUntil(attachPromise.catch(() => undefined));
      try {
        await attachPromise;
      } catch (err) {
        await markDeploymentReleaseVolumeAttachFailed(db, environmentId, releaseId, err);
        throw err;
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
