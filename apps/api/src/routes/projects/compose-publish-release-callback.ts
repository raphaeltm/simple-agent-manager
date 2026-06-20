import { desc, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { parse as parseYaml } from 'yaml';

import * as schema from '../../db/schema';
import type { Env } from '../../env';
import { log, serializeError } from '../../lib/logger';
import { ulid } from '../../lib/ulid';
import { errors } from '../../middleware/error';
import { getProjectAgentDeployEnvironmentId } from '../../services/deployment-control';
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
 * Releases require a NOT-NULL environmentId, but the publish path has no
 * environment name (the workspace callback JWT carries only a workspaceId). We
 * record the release against the project's canonical agent-deploy environment
 * (oldest active agent-deploy-enabled environment).
 *
 * See: .claude/rules/06-api-patterns.md (Hono middleware scoping)
 * See: .claude/rules/34-vm-agent-callback-auth.md
 */
const composePublishReleaseCallbackRoute = new Hono<{ Bindings: Env }>();

interface ServiceReleaseInput {
  serviceName?: unknown;
  sourceRef?: unknown;
  pushedRef?: unknown;
  digest?: unknown;
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
    'Invalid token scope for compose-publish release',
  );

  // Project-level agent-deploy gate. The publish path has no environment name or
  // taskId (workspace callback JWT), so we record the release against the
  // project's canonical active agent-deploy-enabled environment. If none exists,
  // the project has not opted in to agent deploy and cannot publish.
  const environmentId = await getProjectAgentDeployEnvironmentId(db, projectId);
  if (!environmentId) {
    log.warn('compose_publish_release.deploy_disabled', {
      projectId,
      workspaceId,
      action: 'rejected',
    });
    throw errors.forbidden(
      'Agent deployment is disabled for this project. Enable it on a deployment environment before publishing.',
    );
  }

  const submission = await c.req.json().catch(() => null);
  if (!submission || typeof submission !== 'object') {
    throw errors.badRequest('Invalid release submission body');
  }

  const composeYaml = (submission as { composeYaml?: unknown }).composeYaml;
  if (typeof composeYaml !== 'string' || composeYaml.trim() === '') {
    throw errors.badRequest('Release submission is missing composeYaml');
  }

  const servicesRaw = (submission as { services?: unknown }).services;
  const services: ServiceReleaseInput[] = Array.isArray(servicesRaw) ? servicesRaw : [];
  if (services.length === 0) {
    throw errors.badRequest('Release submission must include at least one service');
  }

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
      manifest: JSON.stringify(submission),
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
    reference: (submission as { reference?: unknown }).reference ?? null,
  });

  // Provision a deployment node for this environment if one is not already
  // linked, so the captured release rolls out. Failures here must NOT fail the
  // release recording (the release is already durable); the node can be
  // provisioned on the next release or via the deploy verb.
  let nodeId: string | null = null;
  try {
    const envRows = await db
      .select({ nodeId: schema.deploymentEnvironments.nodeId })
      .from(schema.deploymentEnvironments)
      .where(eq(schema.deploymentEnvironments.id, environmentId))
      .limit(1);
    nodeId = envRows[0]?.nodeId ?? null;

    if (!nodeId) {
      const vmSizeOverride = composeHasModelProvider(composeYaml)
        ? (c.env.DEPLOYMENT_MODEL_RUNNER_VM_SIZE?.trim() || DEPLOYMENT_MODEL_RUNNER_VM_SIZE)
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
