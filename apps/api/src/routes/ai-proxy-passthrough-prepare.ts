/**
 * AI proxy passthrough routes — URL-path-based workspace auth.
 *
 * These routes embed the workspace callback token in the URL path instead of
 * auth headers, so protocol auth headers can be reserved for upstream provider
 * credentials that are resolved server-side.
 *
 * Routes:
 *   POST /ai/proxy/:wstoken/anthropic/v1/messages
 *   POST /ai/proxy/:wstoken/anthropic/v1/messages/count_tokens
 *   POST /ai/proxy/:wstoken/openai/v1/chat/completions
 *
 * The wstoken is verified as a workspace callback token to extract userId,
 * workspaceId, and projectId. Upstream provider credentials are never accepted
 * from, or returned to, tenant workspaces.
 */
import {
  findPricedModel,
  type MeasuredTokenUsage,
  type MonthlyCostCapCheck,
} from '@simple-agent-manager/ai-proxy';
import {
  AI_PROVIDER_BASE_URLS,
  DEFAULT_AI_PROXY_RATE_LIMIT_RPM,
  DEFAULT_AI_PROXY_RATE_LIMIT_WINDOW_SECONDS,
  DEFAULT_AI_PROXY_REQUEST_BODY_MAX_BYTES,
  type Dialect,
} from '@simple-agent-manager/shared';
import { drizzle } from 'drizzle-orm/d1';
import { type Context } from 'hono';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { parsePositiveInt } from '../lib/route-helpers';
import { readRequestJsonRecord, RequestBodyTooLargeError } from '../lib/runtime-validation';
import {
  checkRateLimit,
  createRateLimitKey,
  getCurrentWindowStart,
} from '../middleware/rate-limit';
import { proxyRunUsageRecorder } from '../services/agent-run-usage';
import { isAiProxyEnabled } from '../services/ai-proxy-availability';
import { AIProxyAuthError, verifyAIProxyAuth } from '../services/ai-proxy-shared';
import { checkAiUsageGate } from '../services/ai-token-budget';
import type { PreloadedRuntimeRows } from '../services/workspace-runtime-assets';
import {
  anthropicError,
  anthropicUsageGateError,
  openaiError,
  openaiUsageGateError,
} from './ai-proxy-passthrough-errors';
import {
  type ResolvedProxyUpstream,
  resolveProxyUpstream,
  trimTrailingSlashes,
} from './ai-proxy-passthrough-upstream';

type ProxyContext = Context<{ Bindings: Env }>;

interface PassthroughAuthResult {
  userId: string;
  workspaceId: string;
  projectId: string | null;
  chatSessionId?: string | null;
  agentType?: string | null;
  agentSessionId?: string | null;
  runtimeRows?: PreloadedRuntimeRows;
  agentCredentialReference?: string | null;
  agentCredentialSource?: 'user' | 'project' | 'platform' | null;
  agentCredentialProvider?: string | null;
  agentProviderMode?: string | null;
  agentCredentialGeneration: number;
}

interface PreparedProxyRequest extends PassthroughAuthResult {
  body: Record<string, unknown>;
  modelId: string;
  upstream: ResolvedProxyUpstream;
  /** Insights run usage hook for this request (`proxyRunUsageRecorder`). */
  recordRunUsage: (usage: MeasuredTokenUsage) => Promise<void>;
}

type PreparedProxyResult =
  { ok: true; value: PreparedProxyRequest } | { ok: false; response: Response };

interface PrepareProxyOptions {
  dialect: Dialect;
  jsonContext: string;
  disabledResponse: () => Response;
  authErrorResponse: (error: AIProxyAuthError) => Response;
  invalidTokenResponse: () => Response;
  rateLimitResponse: (c: ProxyContext, resetAt: number) => Response;
  invalidJsonResponse: () => Response;
  requestTooLargeResponse: (maxBytes: number) => Response;
  invalidBodyResponse?: (body: Record<string, unknown>) => Response | null;
  missingModelResponse: () => Response;
  usageGateResponse: (
    reason: 'daily-token-budget' | 'monthly-cost-cap',
    cap?: MonthlyCostCapCheck
  ) => Response;
  missingUpstreamResponse: () => Response;
}

async function verifyPassthroughAuth(wstoken: string, env: Env): Promise<PassthroughAuthResult> {
  const db = drizzle(env.DATABASE, { schema });
  return verifyAIProxyAuth(wstoken, env, db);
}

async function checkPassthroughRateLimit(
  env: Env,
  userId: string
): Promise<{ allowed: boolean; remaining: number; resetAt: number; limit: number }> {
  const rpmLimit =
    Number.parseInt(env.AI_PROXY_RATE_LIMIT_RPM || '', 10) || DEFAULT_AI_PROXY_RATE_LIMIT_RPM;
  const windowSeconds =
    Number.parseInt(env.AI_PROXY_RATE_LIMIT_WINDOW_SECONDS || '', 10) ||
    DEFAULT_AI_PROXY_RATE_LIMIT_WINDOW_SECONDS;
  const windowStart = getCurrentWindowStart(windowSeconds);
  const rateLimitKey = createRateLimitKey('ai-proxy', userId, windowStart);

  const result = await checkRateLimit(env.KV, rateLimitKey, rpmLimit, windowSeconds);
  return { ...result, allowed: result.allowed, limit: rpmLimit };
}

export function retryAfterSeconds(resetAt: number): string {
  const retryAfter = resetAt - Math.floor(Date.now() / 1000);
  return Math.max(1, retryAfter).toString();
}

function anthropicAuthErrorResponse(error: AIProxyAuthError): Response {
  const errType = error.statusCode === 403 ? 'permission_error' : 'authentication_error';
  return anthropicError(error.message, errType, error.statusCode);
}

export function anthropicProxyOptions(
  jsonContext: string,
  rateLimitResponse: PrepareProxyOptions['rateLimitResponse']
): PrepareProxyOptions {
  return {
    dialect: 'anthropic',
    jsonContext,
    disabledResponse: () => anthropicError('AI proxy is disabled', 'api_error', 503),
    authErrorResponse: anthropicAuthErrorResponse,
    invalidTokenResponse: () =>
      anthropicError('Invalid or expired workspace token', 'authentication_error', 401),
    rateLimitResponse,
    invalidJsonResponse: () =>
      anthropicError('Invalid JSON in request body', 'invalid_request_error', 400),
    requestTooLargeResponse: (maxBytes) =>
      anthropicError(`Request body exceeds ${maxBytes} bytes`, 'invalid_request_error', 413),
    missingModelResponse: () => anthropicError('model is required', 'invalid_request_error', 400),
    usageGateResponse: anthropicUsageGateError,
    missingUpstreamResponse: () =>
      anthropicError('No compatible upstream credential configured.', 'authentication_error', 401),
  };
}

export function openaiProxyOptions(jsonContext: string): PrepareProxyOptions {
  return {
    dialect: 'openai-compatible',
    jsonContext,
    disabledResponse: () => openaiError('AI proxy is disabled', 'service_unavailable', 503),
    authErrorResponse: (error) =>
      openaiError(error.message, 'invalid_request_error', error.statusCode),
    invalidTokenResponse: () =>
      openaiError('Invalid or expired workspace token', 'invalid_request_error', 401),
    rateLimitResponse: (c, resetAt) => {
      c.header('Retry-After', retryAfterSeconds(resetAt));
      return openaiError('Rate limit exceeded. Please try again later.', 'rate_limit_error', 429);
    },
    invalidJsonResponse: () => openaiError('Invalid JSON body', 'invalid_request_error', 400),
    requestTooLargeResponse: (maxBytes) =>
      openaiError(`Request body exceeds ${maxBytes} bytes`, 'invalid_request_error', 413),
    invalidBodyResponse: (body) =>
      !Array.isArray(body.messages) || body.messages.length === 0
        ? openaiError('messages array is required', 'invalid_request_error', 400)
        : null,
    missingModelResponse: () => openaiError('model is required', 'invalid_request_error', 400),
    usageGateResponse: openaiUsageGateError,
    missingUpstreamResponse: () =>
      openaiError('No compatible upstream credential configured.', 'invalid_request_error', 401),
  };
}

/** A model id prices only its vendor's endpoint, not an arbitrary compatible alias. */
function hasCanonicalCatalogPrice(upstream: ResolvedProxyUpstream, modelId: string): boolean {
  const model = findPricedModel(modelId);
  if (!model || model.provider === 'workers-ai') return false;
  const dialect = model.provider === 'anthropic' ? 'anthropic' : 'openai-compatible';
  if (upstream.dialect !== dialect) return false;
  try {
    const actual = new URL(upstream.baseUrl);
    const canonical = new URL(AI_PROVIDER_BASE_URLS[model.provider]);
    return (
      !actual.username &&
      !actual.password &&
      !actual.search &&
      !actual.hash &&
      actual.origin === canonical.origin &&
      trimTrailingSlashes(actual.pathname) === trimTrailingSlashes(canonical.pathname)
    );
  } catch {
    return false;
  }
}

/** Admission depends on the resolved owner; locally funded calls must be priceable. */
async function enforcePassthroughFunding(
  c: ProxyContext,
  userId: string,
  modelId: string,
  upstream: ResolvedProxyUpstream,
  options: PrepareProxyOptions
): Promise<Response | null> {
  const platformBilled = upstream.credentialSource === 'platform';
  // Passthrough goes straight to the provider on every installation, never through AI Gateway, so
  // SAM's catalog price is the only record of a platform-funded call's spend. An unpriced call
  // would count $0 against the monthly cap and the administrator ceiling, with or without a
  // gateway, so it is refused everywhere (idea 01M8BX1YRVN5JQ8Y2JSQB7F0QM).
  if (platformBilled && !hasCanonicalCatalogPrice(upstream, modelId)) {
    const message =
      'Model and upstream endpoint must match a catalog-priced provider to use an installation-funded credential.';
    return options.dialect === 'anthropic'
      ? anthropicError(message, 'invalid_request_error', 400)
      : openaiError(message, 'invalid_request_error', 400);
  }
  const usageGate = await checkAiUsageGate(c.env.KV, userId, c.env, { platformBilled });
  if (usageGate.allowed) return null;
  return options.usageGateResponse(
    usageGate.reason,
    usageGate.reason === 'monthly-cost-cap' ? usageGate.monthlyCap : undefined
  );
}

export async function prepareProxyRequest(
  c: ProxyContext,
  options: PrepareProxyOptions
): Promise<PreparedProxyResult> {
  const wstoken = c.req.param('wstoken');
  if (!wstoken) {
    return { ok: false, response: options.invalidTokenResponse() };
  }

  let auth: PassthroughAuthResult;
  try {
    auth = await verifyPassthroughAuth(wstoken, c.env);
  } catch (err) {
    if (err instanceof AIProxyAuthError) {
      return { ok: false, response: options.authErrorResponse(err) };
    }
    return { ok: false, response: options.invalidTokenResponse() };
  }

  if (!(await isAiProxyEnabled(c.env))) return { ok: false, response: options.disabledResponse() };

  const { allowed, remaining, resetAt, limit } = await checkPassthroughRateLimit(
    c.env,
    auth.userId
  );
  c.header('X-RateLimit-Limit', limit.toString());
  c.header('X-RateLimit-Remaining', remaining.toString());
  c.header('X-RateLimit-Reset', resetAt.toString());
  if (!allowed) {
    return { ok: false, response: options.rateLimitResponse(c, resetAt) };
  }

  let body: Record<string, unknown>;
  try {
    const maxBodyBytes = parsePositiveInt(
      c.env.AI_PROXY_REQUEST_BODY_MAX_BYTES,
      DEFAULT_AI_PROXY_REQUEST_BODY_MAX_BYTES
    );
    body = await readRequestJsonRecord(c.req.raw, options.jsonContext, maxBodyBytes);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return { ok: false, response: options.requestTooLargeResponse(error.maxBytes) };
    }
    return { ok: false, response: options.invalidJsonResponse() };
  }

  const invalidBodyResponse = options.invalidBodyResponse?.(body);
  if (invalidBodyResponse) {
    return { ok: false, response: invalidBodyResponse };
  }

  const modelId = typeof body.model === 'string' ? body.model : undefined;
  if (!modelId) {
    return { ok: false, response: options.missingModelResponse() };
  }

  const upstream = await resolveProxyUpstream({
    env: c.env,
    userId: auth.userId,
    workspaceId: auth.workspaceId,
    projectId: auth.projectId,
    agentType: auth.agentType,
    agentSessionId: auth.agentSessionId,
    runtimeRows: auth.runtimeRows,
    dialect: options.dialect,
  });
  if (!upstream) {
    return { ok: false, response: options.missingUpstreamResponse() };
  }

  const fundingError = await enforcePassthroughFunding(c, auth.userId, modelId, upstream, options);
  if (fundingError) return { ok: false, response: fundingError };

  // Insights run usage: the measured tokens go to this workspace's run, keyed by the credential
  // the proxy forwards with.
  const recordRunUsage = proxyRunUsageRecorder(c.env, auth, {
    model: modelId,
    credentialReference: upstream.credentialReference,
    credentialSource: upstream.credentialSource,
  });
  return { ok: true, value: { ...auth, body, modelId, upstream, recordRunUsage } };
}
