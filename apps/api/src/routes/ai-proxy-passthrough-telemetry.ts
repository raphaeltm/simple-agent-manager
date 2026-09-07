import type { Context } from 'hono';

import type { Env } from '../env';
import { log } from '../lib/logger';
import { updateAIProxyAgentCredentialAttribution } from '../services/ai-proxy-shared';
import { optionalExecutionContext } from '../services/ai-token-usage-accounting';
import { recordProxyCredentialLimitObservationsFromHeaders } from '../services/credential-limit-events';

type CredentialSource = 'user' | 'project' | 'platform';
type TelemetryContext = Context<{ Bindings: Env }>;

interface PassthroughTelemetryPreparedRequest {
  projectId?: string | null;
  userId: string;
  workspaceId: string;
  chatSessionId?: string | null;
  agentSessionId?: string | null;
  agentCredentialGeneration: number;
  upstream: {
    agentType: string;
    credentialReference: string;
    credentialSource: CredentialSource;
    credentialProvider: string;
    providerMode: string;
  };
}

interface PassthroughLimitHeadersInput {
  env: Env;
  headers: Headers;
  prepared: PassthroughTelemetryPreparedRequest;
  provider: 'anthropic' | 'openai';
  source: string;
  responseStatus: number;
}

async function recordPassthroughLimitHeaders(input: PassthroughLimitHeadersInput): Promise<void> {
  try {
    await updateAIProxyAgentCredentialAttribution(input.env, input.prepared, {
      credentialReference: input.prepared.upstream.credentialReference,
      credentialSource: input.prepared.upstream.credentialSource,
      credentialProvider: input.prepared.upstream.credentialProvider,
      providerMode: input.prepared.upstream.providerMode,
    });
  } catch (error) {
    log.warn('ai_proxy_passthrough.credential_attribution_update_failed', {
      userId: input.prepared.userId,
      workspaceId: input.prepared.workspaceId,
      agentSessionId: input.prepared.agentSessionId ?? null,
      source: input.source,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  await recordProxyCredentialLimitObservationsFromHeaders(input.env, input.headers, {
    projectId: input.prepared.projectId,
    userId: input.prepared.userId,
    workspaceId: input.prepared.workspaceId,
    chatSessionId: input.prepared.chatSessionId,
    agentSessionId: input.prepared.agentSessionId,
    agentType: input.prepared.upstream.agentType,
    credentialReference: input.prepared.upstream.credentialReference,
    credentialSource: input.prepared.upstream.credentialSource,
    provider: input.provider,
    providerMode: input.prepared.upstream.providerMode,
    source: input.source,
    responseStatus: input.responseStatus,
  });
}

export function schedulePassthroughLimitHeaders(
  c: TelemetryContext,
  input: PassthroughLimitHeadersInput,
): void {
  const telemetry = recordPassthroughLimitHeaders(input).catch((error) => {
    log.warn('ai_proxy_passthrough.credential_limit_telemetry_failed', {
      userId: input.prepared.userId,
      workspaceId: input.prepared.workspaceId,
      agentSessionId: input.prepared.agentSessionId ?? null,
      source: input.source,
      error: error instanceof Error ? error.message : String(error),
    });
  });
  optionalExecutionContext(() => c.executionCtx)?.waitUntil(telemetry);
  void telemetry;
}
