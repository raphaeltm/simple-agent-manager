/**
 * MCP tool handler: get_registry_credentials
 *
 * Returns short-lived Cloudflare managed container registry credentials
 * for agents to push images directly to registry.cloudflare.com.
 *
 * The credential is minted server-side using the platform CF_API_TOKEN.
 * Credential values are NEVER logged or persisted — only audit metadata.
 */
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../../db/schema';
import type { Env } from '../../env';
import { log } from '../../lib/logger';
import { assertAgentDeploymentAllowed } from '../../services/deployment-control';
import {
  getRegistryCredentialRateLimit,
  mintProjectRegistryCredential,
} from '../../services/registry-credentials';
import {
  INTERNAL_ERROR,
  INVALID_PARAMS,
  jsonRpcError,
  type JsonRpcResponse,
  jsonRpcSuccess,
  type McpTokenData,
  sanitizeUserInput,
} from './_helpers';

/** Application-level error code for rate limiting (matches existing MCP rate limit pattern) */
const RATE_LIMITED = -32000;

/**
 * Handle the get_registry_credentials MCP tool call.
 *
 * Rate-limited per project using KV-based fixed-window counter (time-bucketed key).
 */
export async function handleGetRegistryCredentials(
  requestId: string | number | null,
  toolArgs: Record<string, unknown>,
  tokenData: McpTokenData,
  env: Env,
): Promise<JsonRpcResponse> {
  const { projectId, userId, taskId } = tokenData;
  const rawEnvironment = typeof toolArgs.environment === 'string' ? toolArgs.environment.trim() : undefined;
  const environment = rawEnvironment ? sanitizeUserInput(rawEnvironment).slice(0, 200) : undefined;

  if (!environment) {
    return jsonRpcError(
      requestId,
      INVALID_PARAMS,
      'A deployment environment name is required before registry credentials can be minted.',
    );
  }

  const db = drizzle(env.DATABASE, { schema });
  const policyResult = await assertAgentDeploymentAllowed(db, projectId, environment, tokenData);
  if ('error' in policyResult) {
    return jsonRpcError(
      requestId,
      INVALID_PARAMS,
      policyResult.error,
    );
  }

  // Rate limit: per-project credential minting using time-bucketed key (no TTL drift).
  // NOTE: KV does not support atomic read-modify-write. Under high concurrency within
  // the same time bucket, parallel requests may read the same count and both pass the
  // gate. This is acceptable for this use case — the overshoot is bounded by concurrency
  // and the window is wide (300s default). Matches the pattern in _helpers.ts:checkMcpRateLimit.
  const rateLimit = getRegistryCredentialRateLimit(env);
  const now = Math.floor(Date.now() / 1000);
  const windowStart = Math.floor(now / rateLimit.windowSeconds) * rateLimit.windowSeconds;
  const rateLimitKey = `registry-cred-rate:${projectId}:${windowStart}`;
  const currentCount = await env.KV.get(rateLimitKey).then((v) => (v ? parseInt(v, 10) : 0));
  if (currentCount >= rateLimit.maxRequests) {
    return jsonRpcError(
      requestId,
      RATE_LIMITED,
      `Registry credential rate limit exceeded (${rateLimit.maxRequests} per ${rateLimit.windowSeconds}s). Try again later.`,
    );
  }

  // Increment counter BEFORE minting — failed CF API calls still consume quota to prevent
  // unbounded upstream calls during an incident (increment-first pattern from _helpers.ts)
  const newCount = currentCount + 1;
  await env.KV.put(rateLimitKey, String(newCount), {
    expirationTtl: rateLimit.windowSeconds + 60,
  });

  try {
    const result = await mintProjectRegistryCredential(
      env,
      projectId,
      userId,
      taskId,
      environment,
    );

    const instructions = [
      '1. Run: printf \'%s\' "<password>" | docker login -u <username> --password-stdin <registry>',
      `2. Tag your image: docker tag <image> ${result.registry}/${result.namespace}/<app-name>:<tag>`,
      `3. Push: docker push ${result.registry}/${result.namespace}/<app-name>:<tag>`,
      `4. Credentials expire at ${result.expiresAt}`,
      `5. All images MUST be pushed under the namespace: ${result.namespace}`,
    ];

    return jsonRpcSuccess(requestId, {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              registry: result.registry,
              username: result.username,
              password: result.password,
              namespace: result.namespace,
              expiresAt: result.expiresAt,
              instructions,
            },
            null,
            2,
          ),
        },
      ],
    });
  } catch (err) {
    // Log full error server-side for operators; return generic message to agent
    // to avoid leaking CF API internals, account identifiers, or platform config details
    const internalMessage = err instanceof Error ? err.message : String(err);
    log.error('registry_credential_mint_failed', {
      projectId,
      userId,
      taskId,
      environment,
      error: internalMessage,
    });
    return jsonRpcError(
      requestId,
      INTERNAL_ERROR,
      'Registry credential minting is temporarily unavailable. Please try again later.',
    );
  }
}
