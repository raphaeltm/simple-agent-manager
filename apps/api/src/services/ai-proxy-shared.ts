/**
 * Shared helpers for AI proxy endpoints (OpenAI-compatible and Anthropic-native).
 *
 * Extracted to avoid duplication between ai-proxy.ts and ai-proxy-anthropic.ts.
 * Covers: auth verification, workspace resolution, rate limiting, token budget,
 * metadata injection, and Anthropic API key resolution.
 */
import { eq } from 'drizzle-orm';
import type { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { log } from '../lib/logger';
import { getCredentialEncryptionKey } from '../lib/secrets';
import { verifyCallbackToken } from './jwt';
import { getPlatformAgentCredential } from './platform-credentials';

// =============================================================================
// Auth: Callback Token Verification + Workspace Resolution
// =============================================================================

export interface AIProxyAuthResult {
  workspaceId: string;
  userId: string;
  projectId: string | null;
  trialId?: string;
}

/**
 * Extract a callback token from either `Authorization: Bearer <token>` or
 * `x-api-key: <token>` headers. Returns null if neither is present.
 */
export function extractCallbackToken(
  authHeader: string | undefined,
  xApiKeyHeader: string | undefined,
): string | null {
  if (authHeader?.startsWith('Bearer ')) {
    return authHeader.slice(7);
  }
  if (xApiKeyHeader) {
    return xApiKeyHeader;
  }
  return null;
}

/**
 * Verify a callback token and resolve the workspace → userId/projectId.
 * Rejects node-scoped tokens (only workspace-scoped tokens allowed).
 */
export async function verifyAIProxyAuth(
  token: string,
  env: Env,
  db: ReturnType<typeof drizzle>,
): Promise<AIProxyAuthResult> {
  const tokenPayload = await verifyCallbackToken(token, env);

  // Reject node-scoped tokens — only workspace-scoped tokens allowed
  if (tokenPayload.scope === 'node') {
    throw new AIProxyAuthError('Insufficient token scope', 403);
  }

  const workspaceId = tokenPayload.workspace;

  const workspace = await db
    .select({ userId: schema.workspaces.userId, projectId: schema.workspaces.projectId })
    .from(schema.workspaces)
    .where(eq(schema.workspaces.id, workspaceId))
    .get();

  if (!workspace?.userId) {
    log.error('ai_proxy.workspace_not_found', { workspaceId });
    throw new AIProxyAuthError('Workspace not found', 404);
  }

  // Check if this workspace belongs to a trial
  let trialId: string | undefined;
  if (workspace.projectId) {
    const trial = await db
      .select({ id: schema.trials.id })
      .from(schema.trials)
      .where(eq(schema.trials.projectId, workspace.projectId))
      .get();
    trialId = trial?.id;
  }

  return {
    workspaceId,
    userId: workspace.userId,
    projectId: workspace.projectId,
    trialId,
  };
}

export class AIProxyAuthError extends Error {
  constructor(
    message: string,
    public statusCode: number,
  ) {
    super(message);
    this.name = 'AIProxyAuthError';
  }
}

// =============================================================================
// Anthropic API Key Resolution
// =============================================================================

/**
 * Resolve the platform Anthropic API key from platform credentials.
 * Returns null if no credential is configured.
 */
export async function resolveAnthropicApiKey(
  db: ReturnType<typeof drizzle>,
  env: Env,
): Promise<string | null> {
  const encryptionKey = getCredentialEncryptionKey(env);
  const platformCred = await getPlatformAgentCredential(db, 'claude-code', encryptionKey);
  return platformCred?.credential ?? null;
}

// =============================================================================
// AI Gateway Metadata
// =============================================================================

/**
 * Build the `cf-aig-metadata` header value for AI Gateway analytics.
 */
export function buildAIGatewayMetadata(opts: {
  userId: string;
  workspaceId: string;
  projectId?: string | null;
  trialId?: string;
  modelId: string;
  stream: boolean;
  hasTools?: boolean;
}): string {
  return JSON.stringify({
    userId: opts.userId,
    workspaceId: opts.workspaceId,
    projectId: opts.projectId ?? undefined,
    trialId: opts.trialId ?? undefined,
    modelId: opts.modelId,
    stream: opts.stream,
    hasTools: opts.hasTools ?? false,
  });
}

// =============================================================================
// Upstream URL Builders
// =============================================================================

/** Build upstream URL for Anthropic Messages API via AI Gateway. */
export function buildAnthropicGatewayUrl(env: Env): string {
  const gatewayId = env.AI_GATEWAY_ID;
  if (gatewayId) {
    return `https://gateway.ai.cloudflare.com/v1/${env.CF_ACCOUNT_ID}/${gatewayId}/anthropic/v1/messages`;
  }
  // Fallback: direct Anthropic API (no gateway monitoring)
  return 'https://api.anthropic.com/v1/messages';
}

/** Build upstream URL for Anthropic token counting via AI Gateway. */
export function buildAnthropicCountTokensUrl(env: Env): string {
  const gatewayId = env.AI_GATEWAY_ID;
  if (gatewayId) {
    return `https://gateway.ai.cloudflare.com/v1/${env.CF_ACCOUNT_ID}/${gatewayId}/anthropic/v1/messages/count_tokens`;
  }
  return 'https://api.anthropic.com/v1/messages/count_tokens';
}
