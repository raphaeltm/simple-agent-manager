/**
 * AI inference proxy — routes to Workers AI, Anthropic, or OpenAI via Cloudflare AI Gateway.
 *
 * For Workers AI models (@cf/*): transparent pass-through (OpenAI-compatible format).
 * For Anthropic models (claude-*): translates OpenAI format → Anthropic Messages API,
 * forwards through AI Gateway's /anthropic path, translates response back.
 * For OpenAI models (gpt-*): transparent pass-through via AI Gateway's /openai path.
 *
 * Auth: Bearer token in Authorization header (workspace callback token).
 * Rate limit: per-user RPM via KV.
 * Token budget: per-user daily input/output token limits via KV.
 *
 * Mount point: app.route('/ai/v1', aiProxyRoutes) in index.ts.
 */
import {
  AI_PROXY_DEFAULT_MODEL_KV_KEY,
  type AIProxyConfig,
  DEFAULT_AI_PROXY_ALLOWED_MODELS,
  DEFAULT_AI_PROXY_MAX_INPUT_TOKENS_PER_REQUEST,
  DEFAULT_AI_PROXY_MODEL,
  DEFAULT_AI_PROXY_RATE_LIMIT_RPM,
  DEFAULT_AI_PROXY_RATE_LIMIT_WINDOW_SECONDS,
} from '@simple-agent-manager/shared';
import { drizzle } from 'drizzle-orm/d1';
import { type Context, Hono } from 'hono';
import * as v from 'valibot';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { log } from '../lib/logger';
import { readRequestJsonRecord, readResponseJson } from '../lib/runtime-validation';
import { getCredentialEncryptionKey } from '../lib/secrets';
import { checkRateLimit, createRateLimitKey, getCurrentWindowStart } from '../middleware/rate-limit';
import {
  createAnthropicToOpenAIStream,
  translateRequestToAnthropic,
  translateResponseToOpenAI,
} from '../services/ai-anthropic-translate';
import type { UpstreamAuth } from '../services/ai-billing';
import { resolveUnifiedBillingToken, resolveUpstreamAuth } from '../services/ai-billing';
import {
  AIProxyAuthError,
  buildAIGatewayMetadata,
  buildAnthropicGatewayUrl,
  extractCallbackToken,
  isAnthropicModel,
  verifyAIProxyAuth,
} from '../services/ai-proxy-shared';
import { checkAiUsageGate } from '../services/ai-token-budget';
import { attachTokenUsageAccounting } from '../services/ai-token-usage-accounting';
import { getPlatformAgentCredential } from '../services/platform-credentials';

const aiProxyRoutes = new Hono<{ Bindings: Env }>();
type AIProxyContext = Context<{ Bindings: Env }>;
type AIProxyDb = Parameters<typeof verifyAIProxyAuth>[2];
type AIProxyRequestContext = Awaited<ReturnType<typeof verifyAIProxyAuth>> & { db: AIProxyDb };
type ProxyErrorStatus = 400 | 401 | 403 | 404 | 429 | 502 | 503;

const anthropicContentBlockSchema = v.variant('type', [
  v.object({ type: v.literal('text'), text: v.string() }),
  v.object({ type: v.literal('tool_use'), id: v.string(), name: v.string(), input: v.unknown() }),
]);

const anthropicResponseSchema = v.object({
  id: v.string(),
  type: v.literal('message'),
  role: v.literal('assistant'),
  content: v.array(anthropicContentBlockSchema),
  model: v.string(),
  stop_reason: v.nullable(v.string()),
  usage: v.object({
    input_tokens: v.number(),
    output_tokens: v.number(),
  }),
});

// =============================================================================
// Model Routing
// =============================================================================

/** Check if a model ID is an OpenAI model (routed through AI Gateway /openai path). */
function isOpenAIModel(modelId: string): boolean {
  return modelId.startsWith('gpt-') || modelId.startsWith('o1-') || modelId.startsWith('o3-');
}

/** Determine the provider for a model ID. */
function getModelProvider(modelId: string): 'anthropic' | 'openai' | 'workers-ai' {
  if (isAnthropicModel(modelId)) return 'anthropic';
  if (isOpenAIModel(modelId)) return 'openai';
  return 'workers-ai';
}


/** Parse allowed models from env or use defaults, normalizing prefixes. */
function getAllowedModels(env: Env): Set<string> {
  const raw = env.AI_PROXY_ALLOWED_MODELS || DEFAULT_AI_PROXY_ALLOWED_MODELS;
  return new Set(raw.split(',').map((m) => m.trim()).filter(Boolean).map((m) => normalizeModelId(m)));
}

/** Normalize model ID: ensure @cf/ prefix for Workers AI models, leave Anthropic/OpenAI models as-is. */
function normalizeModelId(model: string): string {
  let resolved = model;
  // Strip workers-ai/ prefix that OpenCode may prepend
  if (resolved.startsWith('workers-ai/')) {
    resolved = resolved.slice('workers-ai/'.length);
  }
  // Anthropic and OpenAI models don't get the @cf/ prefix
  if (isAnthropicModel(resolved) || isOpenAIModel(resolved)) {
    return resolved;
  }
  // Add @cf/ prefix if missing — Workers AI requires the full @cf/ path.
  if (!resolved.startsWith('@cf/') && !resolved.startsWith('@hf/')) {
    resolved = `@cf/${resolved}`;
  }
  return resolved;
}

/** Resolve model from request, falling back to admin KV override > env var > shared constant. */
async function resolveModelId(model: string | undefined, env: Env): Promise<string> {
  if (model) return normalizeModelId(model);

  // Priority: KV (admin-set) > env var > shared constant
  const kvConfig = await env.KV.get(AI_PROXY_DEFAULT_MODEL_KV_KEY);
  if (kvConfig) {
    try {
      const parsed: AIProxyConfig = JSON.parse(kvConfig);
      if (parsed.defaultModel) return normalizeModelId(parsed.defaultModel);
    } catch { /* ignore corrupt KV data, fall through */ }
  }

  return normalizeModelId(env.AI_PROXY_DEFAULT_MODEL || DEFAULT_AI_PROXY_MODEL);
}

// =============================================================================
// Upstream URL Builders
// =============================================================================

/** Build upstream URL for Workers AI (OpenAI-compatible). */
function buildWorkersAIUrl(env: Env): string {
  const gatewayId = env.AI_GATEWAY_ID;
  if (gatewayId) {
    return `https://gateway.ai.cloudflare.com/v1/${env.CF_ACCOUNT_ID}/${gatewayId}/workers-ai/v1/chat/completions`;
  }
  return `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/ai/v1/chat/completions`;
}

/** Build upstream URL for OpenAI chat completions via AI Gateway. */
function buildOpenAIUrl(env: Env): string {
  const gatewayId = env.AI_GATEWAY_ID;
  if (gatewayId) {
    return `https://gateway.ai.cloudflare.com/v1/${env.CF_ACCOUNT_ID}/${gatewayId}/openai/v1/chat/completions`;
  }
  // Fallback: direct OpenAI API (no gateway monitoring)
  return 'https://api.openai.com/v1/chat/completions';
}

/** Build upstream URL for OpenAI Responses API via AI Gateway. */
function buildOpenAIResponsesUrl(env: Env): string {
  const gatewayId = env.AI_GATEWAY_ID;
  if (gatewayId) {
    return `https://gateway.ai.cloudflare.com/v1/${env.CF_ACCOUNT_ID}/${gatewayId}/openai/v1/responses`;
  }
  return 'https://api.openai.com/v1/responses';
}


// =============================================================================
// Input Token Estimation
// =============================================================================

/**
 * Estimate input tokens from messages (rough: 1 token ~ 4 chars).
 * Handles both string and array content formats.
 */
function estimateInputTokens(messages: Array<{ role: string; content: unknown }>): number {
  const totalChars = messages.reduce((sum, m) => {
    if (typeof m.content === 'string') return sum + m.content.length;
    if (Array.isArray(m.content)) {
      return sum + m.content.reduce((s: number, p: { type: string; text?: string }) => {
        return s + (p.type === 'text' && p.text ? p.text.length : 0);
      }, 0);
    }
    return sum;
  }, 0);
  return Math.ceil(totalChars / 4);
}

function estimateResponsesInputTokens(body: Record<string, unknown>): number {
  const chunks: string[] = [];
  if (typeof body.instructions === 'string') chunks.push(body.instructions);

  const input = body.input;
  if (typeof input === 'string') {
    chunks.push(input);
  } else if (Array.isArray(input)) {
    chunks.push(JSON.stringify(input));
  } else if (input && typeof input === 'object') {
    chunks.push(JSON.stringify(input));
  }

  return Math.ceil(chunks.join('\n').length / 4);
}

// =============================================================================
// Forwarding Functions
// =============================================================================

/** Forward request to Workers AI (transparent OpenAI-format pass-through). */
async function forwardToWorkersAI(
  env: Env,
  body: Record<string, unknown>,
  modelId: string,
  aigMetadata: string,
): Promise<Response> {
  const gatewayUrl = buildWorkersAIUrl(env);
  const gatewayBody = { ...body, model: modelId };

  const response = await fetch(gatewayUrl, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.CF_API_TOKEN}`,
      'Content-Type': 'application/json',
      'cf-aig-metadata': aigMetadata,
    },
    body: JSON.stringify(gatewayBody),
  });

  if (!response.ok) {
    const errorText = await response.text();
    log.error('ai_proxy.workers_ai_error', {
      status: response.status,
      body: errorText.slice(0, 500),
    });
    return new Response(JSON.stringify({
      error: {
        message: `AI inference failed (${response.status}). Please try again.`,
        type: 'server_error',
      },
    }), { status: response.status, headers: { 'Content-Type': 'application/json' } });
  }

  // Pass through transparently
  const responseHeaders = new Headers();
  const contentType = response.headers.get('content-type');
  if (contentType) responseHeaders.set('Content-Type', contentType);
  if (body.stream) {
    responseHeaders.set('Cache-Control', 'no-cache');
    responseHeaders.set('Connection', 'keep-alive');
    responseHeaders.set('X-Accel-Buffering', 'no');
  }

  return new Response(response.body, { status: response.status, headers: responseHeaders });
}

/** Forward request to Anthropic via AI Gateway (with format translation). */
async function forwardToAnthropic(
  env: Env,
  body: Record<string, unknown>,
  modelId: string,
  aigMetadata: string,
  upstreamAuth: UpstreamAuth,
): Promise<Response> {

  // Translate OpenAI format → Anthropic Messages format
  const anthropicRequest = translateRequestToAnthropic(body, modelId);
  const gatewayUrl = buildAnthropicGatewayUrl(env);

  const response = await fetch(gatewayUrl, {
    method: 'POST',
    headers: {
      ...upstreamAuth.headers,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
      'cf-aig-metadata': aigMetadata,
    },
    body: JSON.stringify(anthropicRequest),
  });

  if (!response.ok) {
    const errorText = await response.text();
    log.error('ai_proxy.anthropic_error', {
      status: response.status,
      body: errorText.slice(0, 500),
    });
    return new Response(JSON.stringify({
      error: {
        message: `AI inference failed (${response.status}). Please try again.`,
        type: 'server_error',
      },
    }), { status: response.status, headers: { 'Content-Type': 'application/json' } });
  }

  // Non-streaming: translate response
  if (!body.stream) {
    const anthropicResponse = await readResponseJson(response, anthropicResponseSchema, 'ai-proxy.anthropic_response');
    const openAIResponse = translateResponseToOpenAI(anthropicResponse);
    return new Response(JSON.stringify(openAIResponse), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Streaming: pipe through format translation transform
  if (!response.body) {
    return new Response(JSON.stringify({
      error: { message: 'No response body from Anthropic', type: 'server_error' },
    }), { status: 502, headers: { 'Content-Type': 'application/json' } });
  }

  const transformStream = createAnthropicToOpenAIStream(modelId);
  const translatedBody = response.body.pipeThrough(transformStream);

  return new Response(translatedBody, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}

/** Forward request to OpenAI via AI Gateway (OpenAI-native format, no translation needed). */
async function forwardToOpenAI(
  env: Env,
  body: Record<string, unknown>,
  modelId: string,
  aigMetadata: string,
  openaiApiKey: string,
): Promise<Response> {
  const gatewayUrl = buildOpenAIUrl(env);
  const gatewayBody = { ...body, model: modelId };

  // Use cf-aig-authorization for Unified Billing when available, otherwise standard Bearer
  const cfToken = resolveUnifiedBillingToken(env);

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'cf-aig-metadata': aigMetadata,
  };
  if (cfToken) {
    headers['cf-aig-authorization'] = `Bearer ${cfToken}`;
  } else {
    headers['Authorization'] = `Bearer ${openaiApiKey}`;
  }

  const response = await fetch(gatewayUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify(gatewayBody),
  });

  if (!response.ok) {
    const errorText = await response.text();
    log.error('ai_proxy.openai_error', {
      status: response.status,
      body: errorText.slice(0, 500),
    });
    return new Response(JSON.stringify({
      error: {
        message: `AI inference failed (${response.status}). Please try again.`,
        type: 'server_error',
      },
    }), { status: response.status, headers: { 'Content-Type': 'application/json' } });
  }

  // OpenAI returns OpenAI-compatible format — pass through transparently
  const responseHeaders = new Headers();
  const contentType = response.headers.get('content-type');
  if (contentType) responseHeaders.set('Content-Type', contentType);
  if (body.stream) {
    responseHeaders.set('Cache-Control', 'no-cache');
    responseHeaders.set('Connection', 'keep-alive');
    responseHeaders.set('X-Accel-Buffering', 'no');
  }

  return new Response(response.body, { status: response.status, headers: responseHeaders });
}

/** Forward request to OpenAI Responses API via AI Gateway. */
async function forwardToOpenAIResponses(
  env: Env,
  body: Record<string, unknown>,
  modelId: string,
  aigMetadata: string,
  openaiApiKey: string,
): Promise<Response> {
  const gatewayUrl = buildOpenAIResponsesUrl(env);
  const gatewayBody = { ...body, model: modelId };
  const cfToken = resolveUnifiedBillingToken(env);

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'cf-aig-metadata': aigMetadata,
  };
  if (cfToken) {
    headers['cf-aig-authorization'] = `Bearer ${cfToken}`;
  } else {
    headers['Authorization'] = `Bearer ${openaiApiKey}`;
  }

  const response = await fetch(gatewayUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify(gatewayBody),
  });

  if (!response.ok) {
    const errorText = await response.text();
    log.error('ai_proxy.openai_responses_error', {
      status: response.status,
      body: errorText.slice(0, 500),
    });
    return new Response(JSON.stringify({
      error: {
        message: `AI inference failed (${response.status}). Please try again.`,
        type: 'server_error',
      },
    }), { status: response.status, headers: { 'Content-Type': 'application/json' } });
  }

  const responseHeaders = new Headers();
  const contentType = response.headers.get('content-type');
  if (contentType) responseHeaders.set('Content-Type', contentType);
  if (body.stream) {
    responseHeaders.set('Cache-Control', 'no-cache');
    responseHeaders.set('Connection', 'keep-alive');
    responseHeaders.set('X-Accel-Buffering', 'no');
  }

  return new Response(response.body, { status: response.status, headers: responseHeaders });
}

function proxyJsonError(
  c: AIProxyContext,
  message: string,
  type: string,
  status: ProxyErrorStatus,
  extra?: Record<string, unknown>,
): Response {
  return c.json({ error: { message, type, ...(extra ?? {}) } }, status);
}

async function prepareAIProxyRequest(c: AIProxyContext): Promise<Response | AIProxyRequestContext> {
  if (c.env.AI_PROXY_ENABLED === 'false') {
    return proxyJsonError(c, 'AI proxy is disabled', 'service_unavailable', 503);
  }

  const token = extractCallbackToken(c.req.header('Authorization'), undefined);
  if (!token) {
    return proxyJsonError(c, 'Missing or invalid Authorization header', 'invalid_request_error', 401);
  }

  const db = drizzle(c.env.DATABASE, { schema });
  try {
    const auth = await verifyAIProxyAuth(token, c.env, db);
    return { ...auth, db };
  } catch (err) {
    if (err instanceof AIProxyAuthError) {
      return proxyJsonError(c, err.message, 'invalid_request_error', err.statusCode as 401 | 403 | 404);
    }
    return proxyJsonError(c, 'Invalid or expired token', 'invalid_request_error', 401);
  }
}

async function enforceRateLimit(c: AIProxyContext, userId: string): Promise<Response | null> {
  const rpmLimit = parseInt(c.env.AI_PROXY_RATE_LIMIT_RPM || '', 10) || DEFAULT_AI_PROXY_RATE_LIMIT_RPM;
  const windowSeconds = parseInt(c.env.AI_PROXY_RATE_LIMIT_WINDOW_SECONDS || '', 10)
    || DEFAULT_AI_PROXY_RATE_LIMIT_WINDOW_SECONDS;
  const windowStart = getCurrentWindowStart(windowSeconds);
  const rateLimitKey = createRateLimitKey('ai-proxy', userId, windowStart);
  const { allowed, remaining, resetAt } = await checkRateLimit(c.env.KV, rateLimitKey, rpmLimit, windowSeconds);

  c.header('X-RateLimit-Limit', rpmLimit.toString());
  c.header('X-RateLimit-Remaining', remaining.toString());
  c.header('X-RateLimit-Reset', resetAt.toString());

  if (allowed) return null;

  const retryAfter = resetAt - Math.floor(Date.now() / 1000);
  c.header('Retry-After', Math.max(1, retryAfter).toString());
  return proxyJsonError(c, 'Rate limit exceeded. Please try again later.', 'rate_limit_error', 429);
}

async function enforceUsageGate(c: AIProxyContext, userId: string): Promise<Response | null> {
  const usageGate = await checkAiUsageGate(c.env.KV, userId, c.env);
  if (usageGate.allowed) return null;

  if (usageGate.reason === 'daily-token-budget') {
    const { budget } = usageGate;
    return proxyJsonError(c, 'Daily token budget exceeded. Resets at midnight UTC.', 'rate_limit_error', 429, {
      budget: {
        inputTokens: { used: budget.usage.inputTokens, limit: budget.inputLimit },
        outputTokens: { used: budget.usage.outputTokens, limit: budget.outputLimit },
      },
    });
  }

  return proxyJsonError(c, 'Monthly cost cap exceeded. Adjust your cap in Settings > Usage.', 'rate_limit_error', 429, {
    monthlyCost: {
      used: usageGate.monthlyCap.costUsd,
      cap: usageGate.monthlyCap.capUsd,
    },
  });
}

function validateAllowedModel(c: AIProxyContext, modelId: string): Response | null {
  const allowedModels = getAllowedModels(c.env);
  if (allowedModels.has(modelId)) return null;

  return proxyJsonError(
    c,
    `Model '${modelId}' is not available. Allowed models: ${Array.from(allowedModels).join(', ')}`,
    'invalid_request_error',
    400,
  );
}

function enforceInputLimit(c: AIProxyContext, estimatedInputTokens: number): Response | null {
  const maxInputPerRequest = parseInt(c.env.AI_PROXY_MAX_INPUT_TOKENS_PER_REQUEST || '', 10)
    || DEFAULT_AI_PROXY_MAX_INPUT_TOKENS_PER_REQUEST;
  if (estimatedInputTokens <= maxInputPerRequest) return null;

  return proxyJsonError(
    c,
    `Request too large: estimated ${estimatedInputTokens} input tokens exceeds limit of ${maxInputPerRequest}`,
    'invalid_request_error',
    400,
  );
}

function buildProxyMetadata(
  auth: Pick<AIProxyRequestContext, 'userId' | 'workspaceId' | 'projectId' | 'trialId'>,
  body: Record<string, unknown>,
  modelId: string,
): string {
  return buildAIGatewayMetadata({
    userId: auth.userId,
    workspaceId: auth.workspaceId,
    projectId: auth.projectId,
    trialId: auth.trialId,
    modelId,
    stream: !!body.stream,
    hasTools: !!body.tools,
  });
}

async function resolveOpenAIProxyKey(c: AIProxyContext, db: AIProxyDb): Promise<string | Response> {
  if (resolveUnifiedBillingToken(c.env)) return '';

  const encryptionKey = getCredentialEncryptionKey(c.env);
  const platformCred = await getPlatformAgentCredential(db, 'codex', encryptionKey);
  if (platformCred?.credential) return platformCred.credential;

  return proxyJsonError(
    c,
    'No OpenAI API key configured. An admin must add a Codex platform credential or configure Unified Billing.',
    'server_error',
    503,
  );
}

function accountingResponse(
  c: AIProxyContext,
  response: Response,
  userId: string,
  estimatedInputTokens: number,
): Promise<Response> {
  let executionCtx: Pick<ExecutionContext, 'waitUntil'> | undefined;
  try { executionCtx = c.executionCtx; } catch { /* no exec ctx in tests */ }
  return attachTokenUsageAccounting(response, {
    env: c.env,
    userId,
    format: 'openai',
    fallbackInputTokens: estimatedInputTokens,
    executionCtx,
  });
}

// =============================================================================
// Main Route Handler
// =============================================================================

/**
 * POST /chat/completions — Proxy to AI Gateway (Workers AI, Anthropic, or OpenAI).
 *
 * Accepts the full OpenAI chat completions format. For Anthropic models,
 * performs format translation transparently.
 */
aiProxyRoutes.post('/chat/completions', async (c) => {
  const prepared = await prepareAIProxyRequest(c);
  if (prepared instanceof Response) return prepared;
  const rateLimitError = await enforceRateLimit(c, prepared.userId);
  if (rateLimitError) return rateLimitError;

  // --- Parse request body ---
  let body: Record<string, unknown>;
  try {
    body = await readRequestJsonRecord(c.req.raw, 'ai-proxy.chat_completions');
  } catch {
    return c.json({ error: { message: 'Invalid JSON body', type: 'invalid_request_error' } }, 400);
  }

  // Minimal validation: messages must be present
  if (!body.messages || !Array.isArray(body.messages) || body.messages.length === 0) {
    return c.json({ error: { message: 'messages array is required', type: 'invalid_request_error' } }, 400);
  }

  // --- Resolve and validate model ---
  const modelId = await resolveModelId(typeof body.model === 'string' ? body.model : undefined, c.env);
  const modelError = validateAllowedModel(c, modelId);
  if (modelError) return modelError;
  const usageError = await enforceUsageGate(c, prepared.userId);
  if (usageError) return usageError;

  // --- Rough input token estimate for pre-flight check ---
  const estimatedInputTokens = estimateInputTokens(body.messages as Array<{ role: string; content: unknown }>);
  const inputLimitError = enforceInputLimit(c, estimatedInputTokens);
  if (inputLimitError) return inputLimitError;

  // --- Per-user metadata for AI Gateway analytics ---
  const aigMetadata = buildProxyMetadata(prepared, body, modelId);
  const provider = getModelProvider(modelId);

  // For Anthropic models, resolve upstream auth (Unified Billing or platform key).
  let anthropicAuth: UpstreamAuth | undefined;
  if (provider === 'anthropic') {
    try {
      anthropicAuth = await resolveUpstreamAuth(c.env, prepared.db);
    } catch (err) {
      log.error('ai_proxy.upstream_auth_failed', {
        userId: prepared.userId,
        workspaceId: prepared.workspaceId,
        reason: err instanceof Error ? err.message : String(err),
      });
      return c.json({
        error: {
          message: 'AI proxy is not configured. Contact an administrator.',
          type: 'server_error',
        },
      }, 503);
    }
  }

  // For OpenAI models, resolve the API key from platform credentials or Unified Billing.
  const openaiApiKey = provider === 'openai' ? await resolveOpenAIProxyKey(c, prepared.db) : '';
  if (openaiApiKey instanceof Response) return openaiApiKey;

  log.info('ai_proxy.forward', {
    userId: prepared.userId,
    workspaceId: prepared.workspaceId,
    modelId,
    provider,
    messageCount: (body.messages as unknown[]).length,
    hasTools: !!body.tools,
    stream: !!body.stream,
    estimatedInputTokens,
  });

  try {
    let response: Response;
    if (provider === 'anthropic') {
      response = await forwardToAnthropic(c.env, body, modelId, aigMetadata, anthropicAuth!);
    } else if (provider === 'openai') {
      response = await forwardToOpenAI(c.env, body, modelId, aigMetadata, openaiApiKey);
    } else {
      response = await forwardToWorkersAI(c.env, body, modelId, aigMetadata);
    }

    log.info('ai_proxy.response', {
      userId: prepared.userId,
      workspaceId: prepared.workspaceId,
      modelId,
      provider,
      status: response.status,
    });

    return accountingResponse(c, response, prepared.userId, estimatedInputTokens);
  } catch (err) {
    log.error('ai_proxy.fetch_error', {
      userId: prepared.userId,
      workspaceId: prepared.workspaceId,
      modelId,
      provider,
      error: err instanceof Error ? err.message : String(err),
    });
    return c.json({
      error: { message: 'Failed to reach upstream. Please try again.', type: 'server_error' },
    }, 502);
  }
});

/**
 * POST /responses — Proxy to OpenAI Responses API via AI Gateway.
 *
 * Current Codex ACP uses the Responses API for custom providers. SAM exposes
 * this only for OpenAI-family models because Workers AI and Anthropic route
 * through the chat/messages proxy paths above.
 */
aiProxyRoutes.post('/responses', async (c) => {
  const prepared = await prepareAIProxyRequest(c);
  if (prepared instanceof Response) return prepared;
  const rateLimitError = await enforceRateLimit(c, prepared.userId);
  if (rateLimitError) return rateLimitError;

  let body: Record<string, unknown>;
  try {
    body = await readRequestJsonRecord(c.req.raw, 'ai-proxy.responses');
  } catch {
    return c.json({ error: { message: 'Invalid JSON body', type: 'invalid_request_error' } }, 400);
  }

  if (!body.input && !body.instructions) {
    return c.json({ error: { message: 'input or instructions is required', type: 'invalid_request_error' } }, 400);
  }

  const modelId = await resolveModelId(typeof body.model === 'string' ? body.model : undefined, c.env);
  const modelError = validateAllowedModel(c, modelId);
  if (modelError) return modelError;

  if (getModelProvider(modelId) !== 'openai') {
    return c.json({
      error: {
        message: 'Responses API is only available for OpenAI models.',
        type: 'invalid_request_error',
      },
    }, 400);
  }

  const usageError = await enforceUsageGate(c, prepared.userId);
  if (usageError) return usageError;

  const estimatedInputTokens = estimateResponsesInputTokens(body);
  const inputLimitError = enforceInputLimit(c, estimatedInputTokens);
  if (inputLimitError) return inputLimitError;

  const aigMetadata = buildProxyMetadata(prepared, body, modelId);
  const openaiApiKey = await resolveOpenAIProxyKey(c, prepared.db);
  if (openaiApiKey instanceof Response) return openaiApiKey;

  log.info('ai_proxy.responses.forward', {
    userId: prepared.userId,
    workspaceId: prepared.workspaceId,
    modelId,
    stream: !!body.stream,
    estimatedInputTokens,
  });

  try {
    const response = await forwardToOpenAIResponses(c.env, body, modelId, aigMetadata, openaiApiKey);

    log.info('ai_proxy.responses.response', {
      userId: prepared.userId,
      workspaceId: prepared.workspaceId,
      modelId,
      status: response.status,
    });

    return accountingResponse(c, response, prepared.userId, estimatedInputTokens);
  } catch (err) {
    log.error('ai_proxy.responses.fetch_error', {
      userId: prepared.userId,
      workspaceId: prepared.workspaceId,
      modelId,
      error: err instanceof Error ? err.message : String(err),
    });
    return c.json({
      error: { message: 'Failed to reach upstream. Please try again.', type: 'server_error' },
    }, 502);
  }
});

/** OpenAI models endpoint — returns available models. Requires callback token auth. */
aiProxyRoutes.get('/models', async (c) => {
  const prepared = await prepareAIProxyRequest(c);
  if (prepared instanceof Response) return prepared;

  const allowedModels = getAllowedModels(c.env);
  const providerOwnerMap: Record<string, string> = {
    anthropic: 'anthropic',
    openai: 'openai',
    'workers-ai': 'cloudflare',
  };
  const models = Array.from(allowedModels).map((id) => ({
    id,
    object: 'model' as const,
    created: 0,
    owned_by: providerOwnerMap[getModelProvider(id)] ?? 'cloudflare',
  }));

  return c.json({ object: 'list', data: models });
});

// Export for testing
export { aiProxyRoutes, getModelProvider, isAnthropicModel, isOpenAIModel, normalizeModelId, resolveModelId };
