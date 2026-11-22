/**
 * AI proxy model routing and request-sizing helpers.
 *
 * Resolves which upstream provider (Workers AI, Anthropic, OpenAI) handles a
 * given model ID, normalizes/validates model IDs against the configured
 * allowlist, and estimates input token counts for pre-flight budget checks.
 *
 * Split out of ai-proxy.ts per .claude/rules/18-file-size-limits.md — pure
 * extraction, no behavior change.
 */
import {
  AI_PROXY_DEFAULT_MODEL_KV_KEY,
  type AIProxyConfig,
  DEFAULT_AI_PROXY_ALLOWED_MODELS,
  DEFAULT_AI_PROXY_MODEL,
  PLATFORM_AI_MODELS,
} from '@simple-agent-manager/shared';

import type { Env } from '../env';
import { log } from '../lib/logger';
import { isAnthropicModel } from '../services/ai-proxy-shared';

// =============================================================================
// Model Routing
// =============================================================================

/** Check if a model ID is an OpenAI model (routed through AI Gateway /openai path). */
export function isOpenAIModel(modelId: string): boolean {
  return (
    modelId.startsWith('gpt-') ||
    modelId.startsWith('o1-') ||
    modelId.startsWith('o3') ||
    modelId.startsWith('o4-')
  );
}

/** Determine the provider for a model ID. */
export function getModelProvider(modelId: string): 'anthropic' | 'openai' | 'workers-ai' {
  if (isAnthropicModel(modelId)) return 'anthropic';
  if (isOpenAIModel(modelId)) return 'openai';
  return 'workers-ai';
}

/** Parse allowed models from env or use defaults, normalizing prefixes. */
export function getAllowedModels(env: Env): Set<string> {
  const raw = env.AI_PROXY_ALLOWED_MODELS || DEFAULT_AI_PROXY_ALLOWED_MODELS;
  return new Set(
    raw
      .split(',')
      .map((m) => m.trim())
      .filter(Boolean)
      .map((m) => normalizeModelId(m))
  );
}

/** Normalize model ID: ensure @cf/ prefix for Workers AI models, leave Anthropic/OpenAI models as-is. */
export function normalizeModelId(model: string): string {
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

/**
 * The AI proxy default below the admin KV override: the `AI_PROXY_DEFAULT_MODEL` var when set,
 * else `DEFAULT_AI_PROXY_MODEL`. Every reader goes through here so an empty var means unset
 * everywhere and the omitted-var proof (`omitted-worker-var-defaults.test.ts`) covers one site.
 */
export function resolveEnvDefaultAIProxyModel(env: Pick<Env, 'AI_PROXY_DEFAULT_MODEL'>): {
  model: string;
  source: 'env' | 'default';
} {
  return env.AI_PROXY_DEFAULT_MODEL
    ? { model: env.AI_PROXY_DEFAULT_MODEL, source: 'env' }
    : { model: DEFAULT_AI_PROXY_MODEL, source: 'default' };
}

/**
 * The admin-set default model stored in KV, or `null` when none is usable.
 *
 * `PUT /api/admin/ai-proxy/config` only accepts `PLATFORM_AI_MODELS` entries that support
 * chat-completions tool calls, so a stored value that fails that same test was saved before the model
 * was removed or re-flagged, usually because the
 * provider retired it (Cloudflare retired Qwen 3 30B and GLM 5.2/5.3 Flash on 2026-11-20, and
 * requests to them return HTTP 410). Such a value is ignored so model-less requests fall through
 * to the env/shared default instead of failing until an admin resets the setting. The KV entry is
 * left in place; the admin page reports the effective default and saving a new one replaces it.
 * Corrupt JSON is ignored the same way.
 */
export async function readAdminDefaultAIProxyModel(
  env: Pick<Env, 'KV'>
): Promise<{ model: string; updatedAt: string | null } | null> {
  const kvConfig = await env.KV.get(AI_PROXY_DEFAULT_MODEL_KV_KEY);
  if (!kvConfig) return null;
  let parsed: AIProxyConfig;
  try {
    parsed = JSON.parse(kvConfig);
  } catch {
    log.warn('ai_proxy.admin_default_model_ignored', { reason: 'corrupt_json' });
    return null;
  }
  if (!parsed?.defaultModel) return null;
  const model = normalizeModelId(parsed.defaultModel);
  if (
    !PLATFORM_AI_MODELS.some(
      (m) => m.id === model && m.supportsChatCompletionsToolCalls !== false
    )
  ) {
    log.warn('ai_proxy.admin_default_model_ignored', {
      reason: 'not_a_selectable_default',
      storedModel: parsed.defaultModel,
      action: 'fell_back_to_env_or_shared_default',
    });
    return null;
  }
  return { model, updatedAt: parsed.updatedAt ?? null };
}

/** Resolve model from request, falling back to admin KV override > env var > shared constant. */
export async function resolveModelId(model: string | undefined, env: Env): Promise<string> {
  if (model) return normalizeModelId(model);

  // Priority: KV (admin-set, still in the registry) > env var > shared constant
  const adminDefault = await readAdminDefaultAIProxyModel(env);
  if (adminDefault) return adminDefault.model;

  return normalizeModelId(resolveEnvDefaultAIProxyModel(env).model);
}

// =============================================================================
// Input Token Estimation
// =============================================================================

/**
 * Estimate input tokens from messages (rough: 1 token ~ 4 chars).
 * Handles both string and array content formats.
 */
export function estimateInputTokens(messages: Array<{ role: string; content: unknown }>): number {
  const totalChars = messages.reduce((sum, m) => {
    if (typeof m.content === 'string') return sum + m.content.length;
    if (Array.isArray(m.content)) {
      return (
        sum +
        m.content.reduce((s: number, p: { type: string; text?: string }) => {
          return s + (p.type === 'text' && p.text ? p.text.length : 0);
        }, 0)
      );
    }
    return sum;
  }, 0);
  return Math.ceil(totalChars / 4);
}

export function estimateResponsesInputTokens(body: Record<string, unknown>): number {
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
