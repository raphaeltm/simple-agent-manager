import { desc, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';

import * as schema from '../../db/schema';
import type { Env } from '../../env';
import { extractBearerToken } from '../../lib/auth-helpers';
import { log } from '../../lib/logger';
import { ulid } from '../../lib/ulid';
import { errors } from '../../middleware/error';
import { getProjectAgentDeployEnvironmentId } from '../../services/deployment-control';
import { verifyCallbackToken } from '../../services/jwt';

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
 * UNLIKE the build-on-node deploy path (deployment-release-submission.ts), this
 * path:
 *   - does NOT enforce MAX_SERVICES_SLICE_2 (images are already built + pushed,
 *     so the multi-service build-on-node gate does not apply); and
 *   - does NOT provision a deployment node (publish is the snapshot verb; deploy
 *     is a later, separate verb).
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

composePublishReleaseCallbackRoute.post('/:id/compose-publish-release', async (c) => {
  // Verify callback JWT (not BetterAuth session cookie)
  const token = extractBearerToken(c.req.header('Authorization'));
  const payload = await verifyCallbackToken(token, c.env);

  if (payload.scope !== undefined && payload.scope !== 'workspace') {
    log.error('compose_publish_release.invalid_token_scope', {
      scope: payload.scope,
      action: 'rejected',
    });
    throw errors.forbidden('Invalid token scope for compose-publish release');
  }

  const projectId = c.req.param('id');
  const db = drizzle(c.env.DATABASE, { schema });

  // The callback JWT carries only a workspaceId. Node-scoped heartbeat tokens
  // carry a node ID in the same claim, so they are rejected above before this
  // lookup. Resolve the owning project + user, then verify the workspace's
  // project matches the route param so a workspace token cannot record a
  // release for another project.
  const workspaceRows = await db
    .select({
      projectId: schema.workspaces.projectId,
      userId: schema.workspaces.userId,
    })
    .from(schema.workspaces)
    .where(eq(schema.workspaces.id, payload.workspace))
    .limit(1);

  const workspace = workspaceRows[0];
  if (!workspace || !workspace.projectId) {
    log.error('compose_publish_release.workspace_not_linked', {
      workspaceId: payload.workspace,
      action: 'rejected',
    });
    throw errors.forbidden('Workspace is not linked to a project');
  }

  if (workspace.projectId !== projectId) {
    log.error('compose_publish_release.project_mismatch', {
      workspaceId: payload.workspace,
      expectedProjectId: workspace.projectId,
      receivedProjectId: projectId,
      action: 'rejected',
    });
    throw errors.forbidden('Project identity verification failed');
  }

  // Project-level agent-deploy gate. The publish path has no environment name or
  // taskId (workspace callback JWT), so we record the release against the
  // project's canonical active agent-deploy-enabled environment. If none exists,
  // the project has not opted in to agent deploy and cannot publish.
  const environmentId = await getProjectAgentDeployEnvironmentId(db, projectId);
  if (!environmentId) {
    log.warn('compose_publish_release.deploy_disabled', {
      projectId,
      workspaceId: payload.workspace,
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
      createdBy: workspace.userId,
    });
  } catch (err) {
    const internalMessage = err instanceof Error ? err.message : String(err);
    log.error('compose_publish_release.insert_failed', {
      projectId,
      environmentId,
      version: nextVersion,
      workspaceId: payload.workspace,
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

  // Response shape matches the agent's Go ReleaseResult struct
  // (releaseId/version/status).
  return c.json({
    releaseId,
    version: nextVersion,
    status: 'created',
  });
});

export { composePublishReleaseCallbackRoute };
