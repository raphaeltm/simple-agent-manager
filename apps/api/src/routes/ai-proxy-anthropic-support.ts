/**
 * Error shapes and platform-credential telemetry for the native Anthropic proxy
 * (`routes/ai-proxy-anthropic.ts`).
 *
 * Split out of ai-proxy-anthropic.ts per .claude/rules/18-file-size-limits.md.
 */
import { DEFAULT_AI_PROXY_REQUEST_BODY_MAX_BYTES } from '@simple-agent-manager/shared';
import type { Context } from 'hono';

import type { Env } from '../env';
import { log } from '../lib/logger';
import { parsePositiveInt } from '../lib/route-helpers';
import { RequestBodyTooLargeError } from '../lib/runtime-validation';
import type { resolveUpstreamAuth } from '../services/ai-billing';
import {
  updateAIProxyAgentCredentialAttribution,
  type verifyAIProxyAuth,
} from '../services/ai-proxy-shared';
import { optionalExecutionContext } from '../services/ai-token-usage-accounting';
import {
  copyCredentialLimitHeaders,
  recordProxyCredentialLimitObservationsFromHeaders,
} from '../services/credential-limit-events';

type AnthropicProxyContext = Context<{ Bindings: Env }>;
type AnthropicProxyAuth = Awaited<ReturnType<typeof verifyAIProxyAuth>>;

/** Return an Anthropic-format error response. */
export function anthropicError(
  message: string,
  type: string,
  status: number,
  headers?: HeadersInit
): Response {
  const responseHeaders = new Headers(headers);
  if (!responseHeaders.has('Content-Type')) responseHeaders.set('Content-Type', 'application/json');
  return new Response(JSON.stringify({ type: 'error', error: { type, message } }), {
    status,
    headers: responseHeaders,
  });
}

export function anthropicProviderErrorHeaders(upstreamHeaders: Headers): Headers {
  const headers = new Headers({ 'Content-Type': 'application/json' });
  copyCredentialLimitHeaders(upstreamHeaders, headers);
  return headers;
}

export function anthropicUsageGateError(
  reason: 'daily-token-budget' | 'monthly-cost-cap'
): Response {
  if (reason === 'daily-token-budget') {
    return anthropicError(
      'Daily token budget exceeded. Resets at midnight UTC.',
      'rate_limit_error',
      429
    );
  }

  return anthropicError(
    'Monthly cost cap exceeded. Adjust your cap in Settings > Usage.',
    'rate_limit_error',
    429
  );
}

export function anthropicBodyMaxBytes(c: AnthropicProxyContext): number {
  return parsePositiveInt(
    c.env.AI_PROXY_REQUEST_BODY_MAX_BYTES,
    DEFAULT_AI_PROXY_REQUEST_BODY_MAX_BYTES
  );
}

export function anthropicBodyParseError(error: unknown): Response {
  if (error instanceof RequestBodyTooLargeError) {
    return anthropicError(
      `Request body exceeds ${error.maxBytes} bytes`,
      'invalid_request_error',
      413
    );
  }
  return anthropicError('Invalid JSON in request body', 'invalid_request_error', 400);
}

async function recordAnthropicPlatformLimitHeaders(input: {
  env: Env;
  response: Response;
  auth: AnthropicProxyAuth;
  upstreamAuth: Awaited<ReturnType<typeof resolveUpstreamAuth>>;
  source: string;
}): Promise<void> {
  try {
    await updateAIProxyAgentCredentialAttribution(input.env, input.auth, input.upstreamAuth);
  } catch (error) {
    log.warn('ai_proxy_anthropic.credential_attribution_update_failed', {
      userId: input.auth.userId,
      workspaceId: input.auth.workspaceId,
      agentSessionId: input.auth.agentSessionId ?? null,
      source: input.source,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  await recordProxyCredentialLimitObservationsFromHeaders(input.env, input.response.headers, {
    projectId: input.auth.projectId,
    userId: input.auth.userId,
    workspaceId: input.auth.workspaceId,
    chatSessionId: input.auth.chatSessionId,
    agentSessionId: input.auth.agentSessionId,
    agentType: input.auth.agentType,
    credentialReference: input.upstreamAuth.credentialReference,
    credentialSource: input.upstreamAuth.credentialSource,
    provider: 'anthropic',
    providerMode: input.upstreamAuth.providerMode,
    source: input.source,
    responseStatus: input.response.status,
  });
}

export function scheduleAnthropicPlatformLimitHeaders(
  c: AnthropicProxyContext,
  input: Parameters<typeof recordAnthropicPlatformLimitHeaders>[0]
): void {
  const telemetry = recordAnthropicPlatformLimitHeaders(input).catch((error) => {
    log.warn('ai_proxy_anthropic.credential_limit_telemetry_failed', {
      userId: input.auth.userId,
      workspaceId: input.auth.workspaceId,
      agentSessionId: input.auth.agentSessionId ?? null,
      source: input.source,
      error: error instanceof Error ? error.message : String(error),
    });
  });
  optionalExecutionContext(() => c.executionCtx)?.waitUntil(telemetry);
  void telemetry;
}
