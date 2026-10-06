/**
 * Platform-credential side of the AI proxy (`routes/ai-proxy.ts`): which platform credential pays
 * for an OpenAI request, the AI Gateway metadata that attributes it, and the usage accounting and
 * credential-limit telemetry recorded from the upstream response.
 *
 * Split out of ai-proxy.ts per .claude/rules/18-file-size-limits.md.
 */
import type { Env } from '../env';
import { log } from '../lib/logger';
import { getCredentialEncryptionKey } from '../lib/secrets';
import { resolveUnifiedBillingToken } from '../services/ai-billing';
import {
  type AIProxyCredentialAttribution,
  buildAIGatewayMetadata,
  updateAIProxyAgentCredentialAttribution,
} from '../services/ai-proxy-shared';
import { attachTokenUsageAccounting } from '../services/ai-token-usage-accounting';
import { recordProxyCredentialLimitObservationsFromHeaders } from '../services/credential-limit-events';
import { getPlatformAgentCredential } from '../services/platform-credentials';
import {
  type AIProxyContext,
  type AIProxyDb,
  type AIProxyRequestContext,
  proxyJsonError,
} from './ai-proxy-admission';

type OpenAIProxyCredential = AIProxyCredentialAttribution & {
  apiKey: string;
  credentialProvider: 'openai';
};

export function buildProxyMetadata(
  auth: Pick<
    AIProxyRequestContext,
    'userId' | 'workspaceId' | 'projectId' | 'chatSessionId' | 'trialId'
  >,
  body: Record<string, unknown>,
  modelId: string
): string {
  return buildAIGatewayMetadata({
    userId: auth.userId,
    workspaceId: auth.workspaceId,
    projectId: auth.projectId,
    sessionId: auth.chatSessionId,
    trialId: auth.trialId,
    modelId,
    stream: !!body.stream,
    hasTools: !!body.tools,
  });
}

export async function resolveOpenAIProxyCredential(
  c: AIProxyContext,
  db: AIProxyDb
): Promise<OpenAIProxyCredential | Response> {
  if (resolveUnifiedBillingToken(c.env)) {
    return {
      apiKey: '',
      credentialReference: 'platform_proxy:cloudflare-ai-gateway',
      credentialSource: 'platform',
      credentialProvider: 'openai',
      providerMode: 'unified-billing',
    };
  }

  const encryptionKey = getCredentialEncryptionKey(c.env);
  const platformCred = await getPlatformAgentCredential(db, 'codex', encryptionKey);
  if (platformCred?.credential) {
    return {
      apiKey: platformCred.credential,
      credentialReference: `platform_credentials:${platformCred.credentialId}`,
      credentialSource: 'platform',
      credentialProvider: 'openai',
      providerMode: 'platform-key',
    };
  }

  return proxyJsonError(
    c,
    'No OpenAI API key configured. An admin must add a Codex platform credential or configure Unified Billing.',
    'server_error',
    503
  );
}

async function recordPlatformProxyLimitHeaders(input: {
  env: Env;
  response: Response;
  prepared: AIProxyRequestContext;
  provider: 'anthropic' | 'openai';
  attribution: AIProxyCredentialAttribution;
  source: string;
}): Promise<void> {
  try {
    await updateAIProxyAgentCredentialAttribution(input.env, input.prepared, input.attribution);
  } catch (error) {
    log.warn('ai_proxy.credential_attribution_update_failed', {
      userId: input.prepared.userId,
      workspaceId: input.prepared.workspaceId,
      agentSessionId: input.prepared.agentSessionId ?? null,
      source: input.source,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  await recordProxyCredentialLimitObservationsFromHeaders(input.env, input.response.headers, {
    projectId: input.prepared.projectId,
    userId: input.prepared.userId,
    workspaceId: input.prepared.workspaceId,
    chatSessionId: input.prepared.chatSessionId,
    agentSessionId: input.prepared.agentSessionId,
    agentType: input.prepared.agentType,
    credentialReference: input.attribution.credentialReference,
    credentialSource: input.attribution.credentialSource,
    provider: input.provider,
    providerMode: input.attribution.providerMode ?? 'sam-proxy',
    source: input.source,
    responseStatus: input.response.status,
  });
}

export function schedulePlatformProxyLimitHeaders(
  c: AIProxyContext,
  input: Parameters<typeof recordPlatformProxyLimitHeaders>[0]
): void {
  const telemetry = recordPlatformProxyLimitHeaders(input).catch((error) => {
    log.warn('ai_proxy.credential_limit_telemetry_failed', {
      userId: input.prepared.userId,
      workspaceId: input.prepared.workspaceId,
      agentSessionId: input.prepared.agentSessionId ?? null,
      source: input.source,
      error: error instanceof Error ? error.message : String(error),
    });
  });
  try {
    c.executionCtx.waitUntil(telemetry);
  } catch {
    /* no execution context in tests */
  }
  void telemetry;
}

export function accountingResponse(
  c: AIProxyContext,
  response: Response,
  userId: string,
  estimatedInputTokens: number
): Promise<Response> {
  let executionCtx: Pick<ExecutionContext, 'waitUntil'> | undefined;
  try {
    executionCtx = c.executionCtx;
  } catch {
    /* no exec ctx in tests */
  }
  return attachTokenUsageAccounting(response, {
    env: c.env,
    userId,
    format: 'openai',
    fallbackInputTokens: estimatedInputTokens,
    executionCtx,
  });
}
