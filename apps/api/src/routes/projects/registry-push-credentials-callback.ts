import { Hono } from 'hono';

import type { Env } from '../../env';
import { log } from '../../lib/logger';
import { errors } from '../../middleware/error';
import { assertAgentDeploymentAllowedForProfile } from '../../services/deployment-control';
import {
  consumeRegistryCredentialRateLimit,
  mintProjectRegistryCredential,
} from '../../services/registry-credentials';
import { verifyWorkspacePublishCallback } from './_callback-auth';

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
 * a workspaceId, so we resolve the project + user from the workspace record,
 * verify it matches the :id route param, and require the vm-agent to send the
 * already policy-checked environment + agent profile context before minting.
 *
 * See: .claude/rules/06-api-patterns.md (Hono middleware scoping)
 * See: .claude/rules/34-vm-agent-callback-auth.md
 */
const registryPushCredentialsCallbackRoute = new Hono<{ Bindings: Env }>();

function cleanOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

registryPushCredentialsCallbackRoute.post('/:id/registry-push-credentials', async (c) => {
  const { projectId, workspaceId, userId, db } = await verifyWorkspacePublishCallback(
    c,
    'registry_push_cred',
    'Invalid token scope for registry push credentials'
  );

  const requestBody = await c.req.json().catch(() => null);
  if (!requestBody || typeof requestBody !== 'object') {
    throw errors.badRequest('Registry credential request body is required');
  }
  const body = requestBody as Record<string, unknown>;
  const environment = cleanOptionalString(body.environment);
  const agentProfileId = cleanOptionalString(body.agentProfileId);
  if (!environment || !agentProfileId) {
    throw errors.badRequest(
      'Registry credential request must include environment and agentProfileId.'
    );
  }

  const policyResult = await assertAgentDeploymentAllowedForProfile(
    db,
    projectId,
    environment,
    agentProfileId
  );
  if ('error' in policyResult) {
    log.warn('registry_push_cred.policy_denied', {
      projectId,
      workspaceId,
      environment,
      agentProfileId,
      action: 'rejected',
    });
    throw errors.forbidden(policyResult.error);
  }

  const rateLimit = await consumeRegistryCredentialRateLimit(c.env, projectId);
  if (!rateLimit.allowed) {
    log.warn('registry_push_cred.rate_limited', {
      projectId,
      maxRequests: rateLimit.maxRequests,
      windowSeconds: rateLimit.windowSeconds,
    });
    throw errors.tooManyRequests(
      `Registry credential rate limit exceeded (${rateLimit.maxRequests} per ${rateLimit.windowSeconds}s). Try again later.`
    );
  }

  try {
    // taskId is '' — the publish path has no task context. permissions include
    // 'pull' so the daemon can resolve the source layers it re-tags.
    const result = await mintProjectRegistryCredential(c.env, projectId, userId, '', environment, {
      permissions: ['pull', 'push'],
    });

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
      workspaceId,
      error: internalMessage,
    });
    throw errors.internal(
      'Registry credential minting is temporarily unavailable. Please try again later.'
    );
  }
});

export { registryPushCredentialsCallbackRoute };
