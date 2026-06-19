import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';

import * as schema from '../../db/schema';
import type { Env } from '../../env';
import { extractBearerToken } from '../../lib/auth-helpers';
import { log } from '../../lib/logger';
import { errors } from '../../middleware/error';
import { isProjectAgentDeployEnabled } from '../../services/deployment-control';
import { verifyCallbackToken } from '../../services/jwt';
import {
  getRegistryCredentialRateLimit,
  mintProjectRegistryCredential,
} from '../../services/registry-credentials';

/**
 * Registry push-credential callback route — mounted BEFORE projectsRoutes in
 * index.ts to avoid the blanket requireAuth() middleware that validates browser
 * session cookies (not callback JWTs).
 *
 * Auth: Callback JWT via Bearer token, verified inline with verifyCallbackToken().
 * Accepts workspace-scoped tokens (the VM agent's per-workspace callback token).
 *
 * The VM agent's publish orchestrator (internal/publish/controlplane.go:
 * MintPushCredentials) calls this endpoint after capturing a
 * `docker compose publish` artifact. It mints a short-lived, project-scoped
 * registry credential so the agent's host docker daemon can re-push the built
 * service images into the project namespace ({accountId}/sam-{projectId}).
 *
 * The agent never receives the account-wide registry credential: the
 * orchestrator runs inside the SAM-controlled vm-agent, and this route mints a
 * scoped credential keyed to the workspace's own project.
 *
 * SECURITY: Credential values are NEVER logged or persisted (only audit
 * metadata, inside mintProjectRegistryCredential). The callback JWT carries only
 * a workspaceId, so we resolve the project + user from the workspace record and
 * verify it matches the :id route param before minting.
 *
 * See: .claude/rules/06-api-patterns.md (Hono middleware scoping)
 * See: .claude/rules/34-vm-agent-callback-auth.md
 */
const registryPushCredentialsCallbackRoute = new Hono<{ Bindings: Env }>();

registryPushCredentialsCallbackRoute.post('/:id/registry-push-credentials', async (c) => {
  // Verify callback JWT (not BetterAuth session cookie)
  const token = extractBearerToken(c.req.header('Authorization'));
  const payload = await verifyCallbackToken(token, c.env);

  if (payload.scope !== undefined && payload.scope !== 'workspace') {
    log.error('registry_push_cred.invalid_token_scope', {
      scope: payload.scope,
      action: 'rejected',
    });
    throw errors.forbidden('Invalid token scope for registry push credentials');
  }

  const projectId = c.req.param('id');
  const db = drizzle(c.env.DATABASE, { schema });

  // The callback JWT carries only a workspaceId. Node-scoped heartbeat tokens
  // carry a node ID in the same claim, so they are rejected above before this
  // lookup. Resolve the owning project + user, then verify the workspace's
  // project matches the route param so a workspace token cannot mint a
  // credential for another project.
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
    log.error('registry_push_cred.workspace_not_linked', {
      workspaceId: payload.workspace,
      action: 'rejected',
    });
    throw errors.forbidden('Workspace is not linked to a project');
  }

  if (workspace.projectId !== projectId) {
    log.error('registry_push_cred.project_mismatch', {
      workspaceId: payload.workspace,
      expectedProjectId: workspace.projectId,
      receivedProjectId: projectId,
      action: 'rejected',
    });
    throw errors.forbidden('Project identity verification failed');
  }

  // Project-level agent-deploy gate. The publish path has no environment name or
  // taskId (workspace callback JWT), so the environment-scoped
  // assertAgentDeploymentAllowed cannot apply — we require the project to have at
  // least one active, agent-deploy-enabled environment instead.
  const deployEnabled = await isProjectAgentDeployEnabled(db, projectId);
  if (!deployEnabled) {
    log.warn('registry_push_cred.deploy_disabled', {
      projectId,
      workspaceId: payload.workspace,
      action: 'rejected',
    });
    throw errors.forbidden(
      'Agent deployment is disabled for this project. Enable it on a deployment environment before publishing.',
    );
  }

  // Rate limit: per-project credential minting using a time-bucketed KV key (no
  // TTL drift). KV has no atomic read-modify-write — under high concurrency in
  // the same window, parallel requests may both pass the gate. Acceptable: the
  // overshoot is bounded by concurrency and the window is wide (300s default).
  // Mirrors routes/mcp/registry-credential-tools.ts.
  const rateLimit = getRegistryCredentialRateLimit(c.env);
  const now = Math.floor(Date.now() / 1000);
  const windowStart = Math.floor(now / rateLimit.windowSeconds) * rateLimit.windowSeconds;
  const rateLimitKey = `registry-cred-rate:${projectId}:${windowStart}`;
  const currentCount = await c.env.KV.get(rateLimitKey).then((v) => (v ? parseInt(v, 10) : 0));
  if (currentCount >= rateLimit.maxRequests) {
    log.warn('registry_push_cred.rate_limited', {
      projectId,
      maxRequests: rateLimit.maxRequests,
      windowSeconds: rateLimit.windowSeconds,
    });
    throw errors.tooManyRequests(
      `Registry credential rate limit exceeded (${rateLimit.maxRequests} per ${rateLimit.windowSeconds}s). Try again later.`,
    );
  }

  // Increment BEFORE minting — failed CF API calls still consume quota to bound
  // upstream calls during an incident (increment-first pattern).
  await c.env.KV.put(rateLimitKey, String(currentCount + 1), {
    expirationTtl: rateLimit.windowSeconds + 60,
  });

  try {
    // taskId is '' — the publish path has no task context. permissions include
    // 'pull' so the daemon can resolve the source layers it re-tags.
    const result = await mintProjectRegistryCredential(
      c.env,
      projectId,
      workspace.userId,
      '',
      undefined,
      { permissions: ['pull', 'push'] },
    );

    // Response shape matches the agent's Go PushCredentials struct
    // (registry/username/password/namespace/expiresAt). The Go decode rejects
    // empty registry or namespace.
    return c.json({
      registry: result.registry,
      username: result.username,
      password: result.password,
      namespace: result.namespace,
      expiresAt: result.expiresAt,
    });
  } catch (err) {
    const internalMessage = err instanceof Error ? err.message : String(err);
    log.error('registry_push_cred.mint_failed', {
      projectId,
      workspaceId: payload.workspace,
      error: internalMessage,
    });
    throw errors.internal(
      'Registry credential minting is temporarily unavailable. Please try again later.',
    );
  }
});

export { registryPushCredentialsCallbackRoute };
