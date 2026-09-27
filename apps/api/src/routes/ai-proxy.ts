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
import { Hono } from 'hono';

import type { Env } from '../env';
import { log } from '../lib/logger';
import { readRequestJsonRecord } from '../lib/runtime-validation';
import type { UpstreamAuth } from '../services/ai-billing';
import { resolveUpstreamAuth } from '../services/ai-billing';
import { isAnthropicModel } from '../services/ai-proxy-shared';
import {
  aiProxyBodyParseError,
  aiProxyRequestBodyMaxBytes,
  enforceInputLimit,
  enforceRateLimit,
  enforceUsageGate,
  prepareAIProxyRequest,
  validateAllowedModel,
} from './ai-proxy-admission';
import {
  estimateInputTokens,
  estimateResponsesInputTokens,
  getAllowedModels,
  getModelProvider,
  isOpenAIModel,
  normalizeModelId,
  resolveModelId,
} from './ai-proxy-model-resolution';
import {
  accountingResponse,
  buildProxyMetadata,
  resolveOpenAIProxyCredential,
  schedulePlatformProxyLimitHeaders,
} from './ai-proxy-platform-billing';
import {
  forwardToAnthropic,
  forwardToOpenAI,
  forwardToOpenAIResponses,
  forwardToWorkersAI,
} from './ai-proxy-upstream';

const aiProxyRoutes = new Hono<{ Bindings: Env }>();

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
    body = await readRequestJsonRecord(
      c.req.raw,
      'ai-proxy.chat_completions',
      aiProxyRequestBodyMaxBytes(c)
    );
  } catch (error) {
    return aiProxyBodyParseError(c, error);
  }

  // Minimal validation: messages must be present
  if (!body.messages || !Array.isArray(body.messages) || body.messages.length === 0) {
    return c.json(
      { error: { message: 'messages array is required', type: 'invalid_request_error' } },
      400
    );
  }

  // --- Resolve and validate model ---
  const modelId = await resolveModelId(
    typeof body.model === 'string' ? body.model : undefined,
    c.env
  );
  const modelError = validateAllowedModel(c, modelId);
  if (modelError) return modelError;
  const usageError = await enforceUsageGate(c, prepared.userId);
  if (usageError) return usageError;

  // --- Rough input token estimate for pre-flight check ---
  const estimatedInputTokens = estimateInputTokens(
    body.messages as Array<{ role: string; content: unknown }>
  );
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
      return c.json(
        {
          error: {
            message: 'AI proxy is not configured. Contact an administrator.',
            type: 'server_error',
          },
        },
        503
      );
    }
  }

  // For OpenAI models, resolve the API key from platform credentials or Unified Billing.
  const openaiCredential =
    provider === 'openai' ? await resolveOpenAIProxyCredential(c, prepared.db) : undefined;
  if (openaiCredential instanceof Response) return openaiCredential;

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
      if (!anthropicAuth) {
        // provider === 'anthropic' guarantees anthropicAuth was resolved above
        // (the function already returned on failure) — should never happen.
        throw new Error('Internal error: missing Anthropic upstream auth for anthropic provider');
      }
      response = await forwardToAnthropic(c.env, body, modelId, aigMetadata, anthropicAuth);
    } else if (provider === 'openai') {
      if (!openaiCredential) {
        throw new Error('Internal error: missing OpenAI upstream auth for openai provider');
      }
      response = await forwardToOpenAI(c.env, body, modelId, aigMetadata, openaiCredential.apiKey);
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

    if (provider === 'anthropic' && anthropicAuth) {
      schedulePlatformProxyLimitHeaders(c, {
        env: c.env,
        response,
        prepared,
        provider: 'anthropic',
        attribution: anthropicAuth,
        source: 'ai-proxy.anthropic.chat_completions',
      });
    } else if (provider === 'openai' && openaiCredential) {
      schedulePlatformProxyLimitHeaders(c, {
        env: c.env,
        response,
        prepared,
        provider: 'openai',
        attribution: openaiCredential,
        source: 'ai-proxy.openai.chat_completions',
      });
    }

    return accountingResponse(c, response, prepared.userId, estimatedInputTokens);
  } catch (err) {
    log.error('ai_proxy.fetch_error', {
      userId: prepared.userId,
      workspaceId: prepared.workspaceId,
      modelId,
      provider,
      error: err instanceof Error ? err.message : String(err),
    });
    return c.json(
      {
        error: { message: 'Failed to reach upstream. Please try again.', type: 'server_error' },
      },
      502
    );
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
    body = await readRequestJsonRecord(
      c.req.raw,
      'ai-proxy.responses',
      aiProxyRequestBodyMaxBytes(c)
    );
  } catch (error) {
    return aiProxyBodyParseError(c, error);
  }

  if (!body.input && !body.instructions) {
    return c.json(
      { error: { message: 'input or instructions is required', type: 'invalid_request_error' } },
      400
    );
  }

  const modelId = await resolveModelId(
    typeof body.model === 'string' ? body.model : undefined,
    c.env
  );
  const modelError = validateAllowedModel(c, modelId);
  if (modelError) return modelError;

  if (getModelProvider(modelId) !== 'openai') {
    return c.json(
      {
        error: {
          message: 'Responses API is only available for OpenAI models.',
          type: 'invalid_request_error',
        },
      },
      400
    );
  }

  const usageError = await enforceUsageGate(c, prepared.userId);
  if (usageError) return usageError;

  const estimatedInputTokens = estimateResponsesInputTokens(body);
  const inputLimitError = enforceInputLimit(c, estimatedInputTokens);
  if (inputLimitError) return inputLimitError;

  const aigMetadata = buildProxyMetadata(prepared, body, modelId);
  const openaiCredential = await resolveOpenAIProxyCredential(c, prepared.db);
  if (openaiCredential instanceof Response) return openaiCredential;

  log.info('ai_proxy.responses.forward', {
    userId: prepared.userId,
    workspaceId: prepared.workspaceId,
    modelId,
    stream: !!body.stream,
    estimatedInputTokens,
  });

  try {
    const response = await forwardToOpenAIResponses(
      c.env,
      body,
      modelId,
      aigMetadata,
      openaiCredential.apiKey
    );

    log.info('ai_proxy.responses.response', {
      userId: prepared.userId,
      workspaceId: prepared.workspaceId,
      modelId,
      status: response.status,
    });

    schedulePlatformProxyLimitHeaders(c, {
      env: c.env,
      response,
      prepared,
      provider: 'openai',
      attribution: openaiCredential,
      source: 'ai-proxy.openai.responses',
    });

    return accountingResponse(c, response, prepared.userId, estimatedInputTokens);
  } catch (err) {
    log.error('ai_proxy.responses.fetch_error', {
      userId: prepared.userId,
      workspaceId: prepared.workspaceId,
      modelId,
      error: err instanceof Error ? err.message : String(err),
    });
    return c.json(
      {
        error: { message: 'Failed to reach upstream. Please try again.', type: 'server_error' },
      },
      502
    );
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
export {
  aiProxyRoutes,
  getModelProvider,
  isAnthropicModel,
  isOpenAIModel,
  normalizeModelId,
  resolveModelId,
};
