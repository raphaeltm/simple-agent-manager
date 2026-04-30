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
import { Hono } from 'hono';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { log } from '../lib/logger';
import { checkRateLimit, createRateLimitKey, getCurrentWindowStart } from '../middleware/rate-limit';
import {
  createAnthropicToOpenAIStream,
  translateRequestToAnthropic,
  translateResponseToOpenAI,
} from '../services/ai-anthropic-translate';
import {
  AIProxyAuthError,
  buildAIGatewayMetadata,
  buildAnthropicGatewayUrl,
  extractCallbackToken,
  isAnthropicModel,
  resolveAnthropicApiKey,
  verifyAIProxyAuth,
} from '../services/ai-proxy-shared';
import { checkTokenBudget } from '../services/ai-token-budget';
import { getCredentialEncryptionKey } from '../lib/secrets';
import { getPlatformAgentCredential } from '../services/platform-credentials';

const aiProxyRoutes = new Hono<{ Bindings: Env }>();

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
      'cf-aig-collect-log': 'false',
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
  anthropicApiKey: string,
): Promise<Response> {

  // Translate OpenAI format → Anthropic Messages format
  const anthropicRequest = translateRequestToAnthropic(body, modelId);
  const gatewayUrl = buildAnthropicGatewayUrl(env);

  const response = await fetch(gatewayUrl, {
    method: 'POST',
    headers: {
      'x-api-key': anthropicApiKey,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
      'cf-aig-metadata': aigMetadata,
      'cf-aig-collect-log': 'false',
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
    const anthropicResponse = await response.json() as Record<string, unknown>;
    const openAIResponse = translateResponseToOpenAI(anthropicResponse as never);
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
  const authHeader = env.CF_AIG_TOKEN
    ? undefined
    : `Bearer ${openaiApiKey}`;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'cf-aig-metadata': aigMetadata,
  };
  if (env.CF_AIG_TOKEN) {
    headers['cf-aig-authorization'] = `Bearer ${env.CF_AIG_TOKEN}`;
  }
  if (authHeader) {
    headers['Authorization'] = authHeader;
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
  // Kill switch
  if (c.env.AI_PROXY_ENABLED === 'false') {
    return c.json({ error: { message: 'AI proxy is disabled', type: 'service_unavailable' } }, 503);
  }

  // --- Auth: extract token from Authorization: Bearer header ---
  const token = extractCallbackToken(c.req.header('Authorization'), undefined);
  if (!token) {
    return c.json({ error: { message: 'Missing or invalid Authorization header', type: 'invalid_request_error' } }, 401);
  }

  const db = drizzle(c.env.DATABASE, { schema });
  let auth;
  try {
    auth = await verifyAIProxyAuth(token, c.env, db);
  } catch (err) {
    if (err instanceof AIProxyAuthError) {
      return c.json({ error: { message: err.message, type: 'invalid_request_error' } }, err.statusCode as 401 | 403 | 404);
    }
    return c.json({ error: { message: 'Invalid or expired token', type: 'invalid_request_error' } }, 401);
  }

  const { userId, workspaceId, projectId, trialId } = auth;

  // --- Rate limit: per-user RPM ---
  const rpmLimit = parseInt(c.env.AI_PROXY_RATE_LIMIT_RPM || '', 10) || DEFAULT_AI_PROXY_RATE_LIMIT_RPM;
  const windowSeconds = parseInt(c.env.AI_PROXY_RATE_LIMIT_WINDOW_SECONDS || '', 10) || DEFAULT_AI_PROXY_RATE_LIMIT_WINDOW_SECONDS;
  const windowStart = getCurrentWindowStart(windowSeconds);
  const rateLimitKey = createRateLimitKey('ai-proxy', userId, windowStart);

  const { allowed: rpmAllowed, remaining, resetAt } = await checkRateLimit(
    c.env.KV,
    rateLimitKey,
    rpmLimit,
    windowSeconds,
  );

  c.header('X-RateLimit-Limit', rpmLimit.toString());
  c.header('X-RateLimit-Remaining', remaining.toString());
  c.header('X-RateLimit-Reset', resetAt.toString());

  if (!rpmAllowed) {
    const retryAfter = resetAt - Math.floor(Date.now() / 1000);
    c.header('Retry-After', Math.max(1, retryAfter).toString());
    return c.json(
      { error: { message: 'Rate limit exceeded. Please try again later.', type: 'rate_limit_error' } },
      429,
    );
  }

  // --- Parse request body ---
  let body: Record<string, unknown>;
  try {
    body = await c.req.json() as Record<string, unknown>;
  } catch {
    return c.json({ error: { message: 'Invalid JSON body', type: 'invalid_request_error' } }, 400);
  }

  // Minimal validation: messages must be present
  if (!body.messages || !Array.isArray(body.messages) || body.messages.length === 0) {
    return c.json({ error: { message: 'messages array is required', type: 'invalid_request_error' } }, 400);
  }

  // --- Resolve and validate model ---
  const modelId = await resolveModelId(body.model as string | undefined, c.env);
  const allowedModels = getAllowedModels(c.env);
  if (!allowedModels.has(modelId)) {
    return c.json({
      error: {
        message: `Model '${modelId}' is not available. Allowed models: ${Array.from(allowedModels).join(', ')}`,
        type: 'invalid_request_error',
      },
    }, 400);
  }

  // --- Check daily token budget ---
  const budgetCheck = await checkTokenBudget(c.env.KV, userId, c.env);
  if (!budgetCheck.allowed) {
    return c.json({
      error: {
        message: 'Daily token budget exceeded. Resets at midnight UTC.',
        type: 'rate_limit_error',
        budget: {
          inputTokens: { used: budgetCheck.usage.inputTokens, limit: budgetCheck.inputLimit },
          outputTokens: { used: budgetCheck.usage.outputTokens, limit: budgetCheck.outputLimit },
        },
      },
    }, 429);
  }

  // --- Rough input token estimate for pre-flight check ---
  const estimatedInputTokens = estimateInputTokens(body.messages as Array<{ role: string; content: unknown }>);
  const maxInputPerRequest = parseInt(c.env.AI_PROXY_MAX_INPUT_TOKENS_PER_REQUEST || '', 10)
    || DEFAULT_AI_PROXY_MAX_INPUT_TOKENS_PER_REQUEST;
  if (estimatedInputTokens > maxInputPerRequest) {
    return c.json({
      error: {
        message: `Request too large: estimated ${estimatedInputTokens} input tokens exceeds limit of ${maxInputPerRequest}`,
        type: 'invalid_request_error',
      },
    }, 400);
  }

  // --- Per-user metadata for AI Gateway analytics ---
  const aigMetadata = buildAIGatewayMetadata({
    userId,
    workspaceId,
    projectId,
    trialId,
    modelId,
    stream: !!body.stream,
    hasTools: !!body.tools,
  });

  const provider = getModelProvider(modelId);

  // For Anthropic models, resolve the API key from platform credentials (admin-managed).
  // Unified Billing via CF_AIG_TOKEN can also be used (no separate key needed).
  let anthropicApiKey: string | undefined;
  if (provider === 'anthropic' && !c.env.CF_AIG_TOKEN) {
    const key = await resolveAnthropicApiKey(db, c.env);
    if (!key) {
      return c.json({
        error: {
          message: 'No Anthropic API key configured. An admin must add a Claude Code platform credential or configure Unified Billing.',
          type: 'server_error',
        },
      }, 503);
    }
    anthropicApiKey = key;
  }

  // For OpenAI models, resolve the API key from platform credentials or Unified Billing.
  let openaiApiKey: string | undefined;
  if (provider === 'openai' && !c.env.CF_AIG_TOKEN) {
    const encryptionKey = getCredentialEncryptionKey(c.env);
    const platformCred = await getPlatformAgentCredential(db, 'codex', encryptionKey);
    openaiApiKey = platformCred?.credential;
    if (!openaiApiKey) {
      return c.json({
        error: {
          message: 'No OpenAI API key configured. An admin must add a Codex platform credential or configure Unified Billing.',
          type: 'server_error',
        },
      }, 503);
    }
  }

  log.info('ai_proxy.forward', {
    userId,
    workspaceId,
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
      response = await forwardToAnthropic(c.env, body, modelId, aigMetadata, anthropicApiKey ?? '');
    } else if (provider === 'openai') {
      response = await forwardToOpenAI(c.env, body, modelId, aigMetadata, openaiApiKey ?? '');
    } else {
      response = await forwardToWorkersAI(c.env, body, modelId, aigMetadata);
    }

    log.info('ai_proxy.response', {
      userId,
      workspaceId,
      modelId,
      provider,
      status: response.status,
    });

    return response;
  } catch (err) {
    log.error('ai_proxy.fetch_error', {
      userId,
      workspaceId,
      modelId,
      provider,
      error: err instanceof Error ? err.message : String(err),
    });
    return c.json({
      error: { message: 'Failed to reach upstream. Please try again.', type: 'server_error' },
    }, 502);
  }
});

/** OpenAI models endpoint — returns available models. */
aiProxyRoutes.get('/models', async (c) => {
  if (c.env.AI_PROXY_ENABLED === 'false') {
    return c.json({ error: { message: 'AI proxy is disabled', type: 'service_unavailable' } }, 503);
  }

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
