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
} from '@simple-agent-manager/shared';

import type { Env } from '../env';
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

/** Resolve model from request, falling back to admin KV override > env var > shared constant. */
export async function resolveModelId(model: string | undefined, env: Env): Promise<string> {
  if (model) return normalizeModelId(model);

  // Priority: KV (admin-set) > env var > shared constant
  const kvConfig = await env.KV.get(AI_PROXY_DEFAULT_MODEL_KV_KEY);
  if (kvConfig) {
    try {
      const parsed: AIProxyConfig = JSON.parse(kvConfig);
      if (parsed.defaultModel) return normalizeModelId(parsed.defaultModel);
    } catch {
      /* ignore corrupt KV data, fall through */
    }
  }

  return normalizeModelId(env.AI_PROXY_DEFAULT_MODEL || DEFAULT_AI_PROXY_MODEL);
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
