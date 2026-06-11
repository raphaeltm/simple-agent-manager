/**
 * MCP tool handler: get_registry_credentials
 *
 * Returns short-lived Cloudflare managed container registry credentials
 * for agents to push images directly to registry.cloudflare.com.
 *
 * The credential is minted server-side using the platform CF_API_TOKEN.
 * Credential values are NEVER logged or persisted — only audit metadata.
 */
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../../db/schema';
import type { Env } from '../../env';
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
} from './_helpers';

/**
 * Handle the get_registry_credentials MCP tool call.
 *
 * Rate-limited per project using KV-based sliding window.
 */
export async function handleGetRegistryCredentials(
  requestId: string | number | null,
  toolArgs: Record<string, unknown>,
  tokenData: McpTokenData,
  env: Env,
): Promise<JsonRpcResponse> {
  const { projectId, userId, taskId } = tokenData;
  const environment = typeof toolArgs.environment === 'string' ? toolArgs.environment.trim() : undefined;

  // If an environment name is provided, verify it exists and belongs to this project
  if (environment) {
    const db = drizzle(env.DATABASE, { schema });
    const envRows = await db
      .select({ id: schema.deploymentEnvironments.id })
      .from(schema.deploymentEnvironments)
      .where(
        and(
          eq(schema.deploymentEnvironments.projectId, projectId),
          eq(schema.deploymentEnvironments.name, environment),
          eq(schema.deploymentEnvironments.status, 'active'),
        ),
      )
      .limit(1);

    if (envRows.length === 0) {
      return jsonRpcError(
        requestId,
        INVALID_PARAMS,
        `Deployment environment '${environment}' not found or inactive for this project.`,
      );
    }
  }

  // Rate limit: per-project credential minting
  const rateLimit = getRegistryCredentialRateLimit(env);
  const rateLimitKey = `registry-cred-rate:${projectId}`;
  const currentCount = await env.KV.get(rateLimitKey).then((v) => (v ? parseInt(v, 10) : 0));
  if (currentCount >= rateLimit.maxRequests) {
    return jsonRpcError(
      requestId,
      INTERNAL_ERROR,
      `Registry credential rate limit exceeded (${rateLimit.maxRequests} per ${rateLimit.windowSeconds}s). Try again later.`,
    );
  }

  try {
    const result = await mintProjectRegistryCredential(
      env,
      projectId,
      userId,
      taskId,
      environment,
    );

    // Increment rate limit counter
    const newCount = currentCount + 1;
    await env.KV.put(rateLimitKey, String(newCount), {
      expirationTtl: rateLimit.windowSeconds,
    });

    const instructions = [
      '1. Run: docker login -u <username> -p <password> <registry>',
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
    const message = err instanceof Error ? err.message : String(err);
    return jsonRpcError(
      requestId,
      INTERNAL_ERROR,
      `Failed to mint registry credentials: ${message}`,
    );
  }
}
