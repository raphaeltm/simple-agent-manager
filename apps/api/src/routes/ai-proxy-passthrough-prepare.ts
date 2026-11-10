/**
 * Request preparation for the AI proxy passthrough routes (ai-proxy-passthrough.ts): workspace
 * token auth, rate limit, body parsing, usage gate and upstream resolution, plus the guarded
 * upstream fetch.
 */
import {
  DEFAULT_AI_PROXY_RATE_LIMIT_RPM,
  DEFAULT_AI_PROXY_RATE_LIMIT_WINDOW_SECONDS,
  DEFAULT_AI_PROXY_REQUEST_BODY_MAX_BYTES,
  type Dialect,
} from '@simple-agent-manager/shared';
import { drizzle } from 'drizzle-orm/d1';
import type { Context } from 'hono';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { guardedFetch, OutboundRequestRefusedError } from '../lib/network-hosts';
import { parsePositiveInt } from '../lib/route-helpers';
import { readRequestJsonRecord, RequestBodyTooLargeError } from '../lib/runtime-validation';
import {
  checkRateLimit,
  createRateLimitKey,
  getCurrentWindowStart,
} from '../middleware/rate-limit';
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

export type ProxyContext = Context<{ Bindings: Env }>;
export interface PassthroughAuthResult {
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

export interface PreparedProxyRequest extends PassthroughAuthResult {
  body: Record<string, unknown>;
  modelId: string;
  upstream: ResolvedProxyUpstream;
}

export type PreparedProxyResult =
  { ok: true; value: PreparedProxyRequest } | { ok: false; response: Response };

export interface PrepareProxyOptions {
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
  usageGateResponse: (reason: 'daily-token-budget' | 'monthly-cost-cap') => Response;
  missingUpstreamResponse: () => Response;
}

async function verifyPassthroughAuth(wstoken: string, env: Env): Promise<PassthroughAuthResult> {
  const db = drizzle(env.DATABASE, { schema });
  return verifyAIProxyAuth(wstoken, env, db);
}

function trimLeadingSlashes(value: string): string {
  let start = 0;
  while (start < value.length && value.charCodeAt(start) === 47) start++;
  return value.slice(start);
}

export function joinUpstreamUrl(baseUrl: string, path: string): string {
  return `${trimTrailingSlashes(baseUrl)}/${trimLeadingSlashes(path)}`;
}

export function buildUpstreamAuthHeaders(upstream: ResolvedProxyUpstream): Record<string, string> {
  if (
    upstream.capability.authStyle === 'bearer-token' ||
    upstream.dialect === 'openai-compatible'
  ) {
    return { Authorization: `Bearer ${upstream.apiKey}` };
  }
  if (upstream.capability.authStyle === 'api-key' && upstream.dialect === 'anthropic') {
    return { 'x-api-key': upstream.apiKey };
  }
  return {};
}

async function checkPassthroughRateLimit(
  env: Env,
  userId: string
): Promise<{ allowed: boolean; remaining: number; resetAt: number; limit: number }> {
  const rpmLimit =
    parseInt(env.AI_PROXY_RATE_LIMIT_RPM || '', 10) || DEFAULT_AI_PROXY_RATE_LIMIT_RPM;
  const windowSeconds =
    parseInt(env.AI_PROXY_RATE_LIMIT_WINDOW_SECONDS || '', 10) ||
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

export async function prepareProxyRequest(
  c: ProxyContext,
  options: PrepareProxyOptions
): Promise<PreparedProxyResult> {
  if (c.env.AI_PROXY_ENABLED === 'false') {
    return { ok: false, response: options.disabledResponse() };
  }

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

  const usageGate = await checkAiUsageGate(c.env.KV, auth.userId, c.env);
  if (!usageGate.allowed) {
    return { ok: false, response: options.usageGateResponse(usageGate.reason) };
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

  return { ok: true, value: { ...auth, body, modelId, upstream } };
}

export function buildJsonUpstreamHeaders(upstream: ResolvedProxyUpstream): Record<string, string> {
  return {
    ...buildUpstreamAuthHeaders(upstream),
    'Content-Type': 'application/json',
  };
}

export function upstreamFetchErrorMeta(err: unknown): Record<string, string> {
  if (err instanceof OutboundRequestRefusedError) {
    return { errorName: err.name, refusal: err.reason };
  }
  if (err instanceof Error) {
    return { errorName: err.name };
  }
  return { errorType: typeof err };
}

/**
 * The upstream base URL is chosen by the user (an `openai-compatible` credential or a
 * configuration's `baseUrl`), so the request goes through the guarded fetch: public hosts only,
 * and every redirect hop re-validated instead of followed by the runtime. A refused URL or hop
 * throws `OutboundRequestRefusedError`, which each route reports as an upstream failure.
 */
export function fetchProxyUpstream(
  url: string,
  headers: Record<string, string>,
  body: Record<string, unknown>
): Promise<Response> {
  return guardedFetch(
    url,
    { method: 'POST', headers, body: JSON.stringify(body) },
    { allowPrivateNetwork: false }
  );
}

export function addAnthropicRequestHeaders(
  headers: Record<string, string>,
  c: ProxyContext
): Record<string, string> {
  // Anthropic-compatible Messages calls require an API version header.
  // https://docs.anthropic.com/en/api/versioning
  headers['anthropic-version'] = c.req.header('anthropic-version') || '2023-06-01';
  const anthropicBeta = c.req.header('anthropic-beta');
  if (anthropicBeta) headers['anthropic-beta'] = anthropicBeta;
  return headers;
}

