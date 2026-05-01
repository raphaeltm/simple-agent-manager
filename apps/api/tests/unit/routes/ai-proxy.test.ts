/**
 * Unit tests for the AI proxy route (AI Gateway pass-through + Anthropic/OpenAI translation).
 *
 * Tests model ID resolution/normalization, allowlist parsing, provider detection, and model routing.
 */
import { describe, expect, it } from 'vitest';

import {
  getModelProvider,
  isAnthropicModel,
  isOpenAIModel,
  normalizeModelId,
  resolveModelId,
} from '../../../src/routes/ai-proxy';

// =============================================================================
// Model Normalization
// =============================================================================

describe('normalizeModelId', () => {
  it('preserves Workers AI models with @cf/ prefix', () => {
    expect(normalizeModelId('@cf/meta/llama-4-scout-17b-16e-instruct'))
      .toBe('@cf/meta/llama-4-scout-17b-16e-instruct');
  });

  it('adds @cf/ prefix to bare Workers AI model IDs', () => {
    expect(normalizeModelId('meta/llama-4-scout-17b-16e-instruct'))
      .toBe('@cf/meta/llama-4-scout-17b-16e-instruct');
  });

  it('strips workers-ai/ prefix', () => {
    expect(normalizeModelId('workers-ai/@cf/qwen/qwen3-30b-a3b-fp8'))
      .toBe('@cf/qwen/qwen3-30b-a3b-fp8');
  });

  it('preserves @hf/ prefix for HuggingFace models', () => {
    expect(normalizeModelId('@hf/some/model')).toBe('@hf/some/model');
  });

  it('preserves Anthropic model IDs without adding @cf/ prefix', () => {
    expect(normalizeModelId('claude-haiku-4-5-20251001')).toBe('claude-haiku-4-5-20251001');
    expect(normalizeModelId('claude-sonnet-4-6')).toBe('claude-sonnet-4-6');
    expect(normalizeModelId('claude-opus-4-6')).toBe('claude-opus-4-6');
  });

  it('preserves OpenAI model IDs without adding @cf/ prefix', () => {
    expect(normalizeModelId('gpt-4.1')).toBe('gpt-4.1');
    expect(normalizeModelId('gpt-4.1-mini')).toBe('gpt-4.1-mini');
    expect(normalizeModelId('gpt-5.2')).toBe('gpt-5.2');
  });
});

// =============================================================================
// Model Allowlist Parsing (extracted logic test)
// =============================================================================

describe('model allowlist parsing', () => {
  /** Replicates the getAllowedModels normalization logic using normalizeModelId. */
  function parseAndNormalizeModels(raw: string): Set<string> {
    return new Set(
      raw.split(',').map((m) => m.trim()).filter(Boolean).map((m) => normalizeModelId(m)),
    );
  }

  it('parses comma-separated model list', () => {
    const models = parseAndNormalizeModels('@cf/model-a,@cf/model-b,@cf/model-c');
    expect(models.size).toBe(3);
    expect(models.has('@cf/model-a')).toBe(true);
    expect(models.has('@cf/model-c')).toBe(true);
  });

  it('trims whitespace around model names', () => {
    const models = parseAndNormalizeModels(' @cf/model-a , @cf/model-b ');
    expect(models.has('@cf/model-a')).toBe(true);
    expect(models.has('@cf/model-b')).toBe(true);
  });

  it('filters empty strings from trailing commas', () => {
    const models = parseAndNormalizeModels('@cf/model-a,,@cf/model-b,');
    expect(models.size).toBe(2);
  });

  it('preserves Anthropic model IDs without @cf/ prefix', () => {
    const models = parseAndNormalizeModels('claude-haiku-4-5-20251001,@cf/meta/llama-4-scout-17b-16e-instruct');
    expect(models.has('claude-haiku-4-5-20251001')).toBe(true);
    expect(models.has('@cf/meta/llama-4-scout-17b-16e-instruct')).toBe(true);
  });

  it('preserves OpenAI model IDs without @cf/ prefix', () => {
    const models = parseAndNormalizeModels('gpt-4.1,gpt-4.1-mini,@cf/meta/llama-4-scout-17b-16e-instruct');
    expect(models.has('gpt-4.1')).toBe(true);
    expect(models.has('gpt-4.1-mini')).toBe(true);
    expect(models.has('@cf/meta/llama-4-scout-17b-16e-instruct')).toBe(true);
  });

  it('handles mixed provider model lists', () => {
    const models = parseAndNormalizeModels(
      '@cf/meta/llama-4-scout-17b-16e-instruct,claude-sonnet-4-6,gpt-4.1,@cf/google/gemma-3-12b-it',
    );
    expect(models.size).toBe(4);
    expect(models.has('@cf/meta/llama-4-scout-17b-16e-instruct')).toBe(true);
    expect(models.has('claude-sonnet-4-6')).toBe(true);
    expect(models.has('gpt-4.1')).toBe(true);
    expect(models.has('@cf/google/gemma-3-12b-it')).toBe(true);
  });
});

// =============================================================================
// Model ID Resolution
// =============================================================================

describe('resolveModelId', () => {
  /** Mock env with a KV stub that always returns null (no admin override). */
  const mockKV = { get: async () => null } as unknown as KVNamespace;

  const mockEnvWorkersAI = {
    AI_PROXY_DEFAULT_MODEL: '@cf/meta/llama-4-scout-17b-16e-instruct',
    KV: mockKV,
  } as Parameters<typeof resolveModelId>[1];

  const mockEnvAnthropic = {
    AI_PROXY_DEFAULT_MODEL: 'claude-haiku-4-5-20251001',
    KV: mockKV,
  } as Parameters<typeof resolveModelId>[1];

  const mockEnvOpenAI = {
    AI_PROXY_DEFAULT_MODEL: 'gpt-4.1',
    KV: mockKV,
  } as Parameters<typeof resolveModelId>[1];

  it('returns default when model is undefined (Workers AI default)', async () => {
    expect(await resolveModelId(undefined, mockEnvWorkersAI)).toBe('@cf/meta/llama-4-scout-17b-16e-instruct');
  });

  it('returns default when model is undefined (Anthropic default)', async () => {
    expect(await resolveModelId(undefined, mockEnvAnthropic)).toBe('claude-haiku-4-5-20251001');
  });

  it('returns default when model is undefined (OpenAI default)', async () => {
    expect(await resolveModelId(undefined, mockEnvOpenAI)).toBe('gpt-4.1');
  });

  it('returns model as-is when @cf/ prefix present', async () => {
    expect(await resolveModelId('@cf/qwen/qwen3-30b-a3b-fp8', mockEnvWorkersAI))
      .toBe('@cf/qwen/qwen3-30b-a3b-fp8');
  });

  it('strips workers-ai/ prefix', async () => {
    expect(await resolveModelId('workers-ai/@cf/qwen/qwen3-30b-a3b-fp8', mockEnvWorkersAI))
      .toBe('@cf/qwen/qwen3-30b-a3b-fp8');
  });

  it('adds @cf/ prefix when missing (OpenCode strips it)', async () => {
    expect(await resolveModelId('meta/llama-4-scout-17b-16e-instruct', mockEnvWorkersAI))
      .toBe('@cf/meta/llama-4-scout-17b-16e-instruct');
  });

  it('preserves @hf/ prefix for HuggingFace models', async () => {
    expect(await resolveModelId('@hf/some/model', mockEnvWorkersAI))
      .toBe('@hf/some/model');
  });

  it('preserves Anthropic model IDs without adding @cf/ prefix', async () => {
    expect(await resolveModelId('claude-haiku-4-5-20251001', mockEnvWorkersAI))
      .toBe('claude-haiku-4-5-20251001');
  });

  it('preserves full Anthropic model IDs with date suffix', async () => {
    expect(await resolveModelId('claude-sonnet-4-5-20250514', mockEnvWorkersAI))
      .toBe('claude-sonnet-4-5-20250514');
  });

  it('preserves OpenAI model IDs without adding @cf/ prefix', async () => {
    expect(await resolveModelId('gpt-4.1', mockEnvWorkersAI)).toBe('gpt-4.1');
    expect(await resolveModelId('gpt-4.1-mini', mockEnvWorkersAI)).toBe('gpt-4.1-mini');
    expect(await resolveModelId('gpt-5.2', mockEnvWorkersAI)).toBe('gpt-5.2');
  });

  it('reads admin override from KV when no model specified', async () => {
    const kvWithOverride = {
      get: async () => JSON.stringify({ defaultModel: 'claude-haiku-4-5-20251001', updatedAt: '2026-04-20T00:00:00Z' }),
    } as unknown as KVNamespace;

    const envWithKV = { ...mockEnvWorkersAI, KV: kvWithOverride };
    expect(await resolveModelId(undefined, envWithKV)).toBe('claude-haiku-4-5-20251001');
  });

  it('explicit model overrides KV admin setting', async () => {
    const kvWithOverride = {
      get: async () => JSON.stringify({ defaultModel: 'claude-haiku-4-5-20251001', updatedAt: '2026-04-20T00:00:00Z' }),
    } as unknown as KVNamespace;

    const envWithKV = { ...mockEnvWorkersAI, KV: kvWithOverride };
    expect(await resolveModelId('@cf/qwen/qwen3-30b-a3b-fp8', envWithKV)).toBe('@cf/qwen/qwen3-30b-a3b-fp8');
  });

  it('reads OpenAI admin override from KV', async () => {
    const kvWithOverride = {
      get: async () => JSON.stringify({ defaultModel: 'gpt-4.1', updatedAt: '2026-04-30T00:00:00Z' }),
    } as unknown as KVNamespace;

    const envWithKV = { ...mockEnvWorkersAI, KV: kvWithOverride };
    expect(await resolveModelId(undefined, envWithKV)).toBe('gpt-4.1');
  });
});

// =============================================================================
// Anthropic Model Detection
// =============================================================================

describe('isAnthropicModel', () => {
  it('identifies Claude models', () => {
    expect(isAnthropicModel('claude-haiku-4-5-20251001')).toBe(true);
    expect(isAnthropicModel('claude-sonnet-4-6')).toBe(true);
    expect(isAnthropicModel('claude-opus-4-6')).toBe(true);
  });

  it('does not match Workers AI models', () => {
    expect(isAnthropicModel('@cf/meta/llama-4-scout-17b-16e-instruct')).toBe(false);
    expect(isAnthropicModel('@cf/qwen/qwen3-30b-a3b-fp8')).toBe(false);
  });

  it('does not match OpenAI models', () => {
    expect(isAnthropicModel('gpt-4.1')).toBe(false);
    expect(isAnthropicModel('gpt-5.2')).toBe(false);
  });
});

// =============================================================================
// OpenAI Model Detection
// =============================================================================

describe('isOpenAIModel', () => {
  it('identifies GPT models', () => {
    expect(isOpenAIModel('gpt-4.1')).toBe(true);
    expect(isOpenAIModel('gpt-4.1-mini')).toBe(true);
    expect(isOpenAIModel('gpt-5.2')).toBe(true);
  });

  it('identifies o-series reasoning models', () => {
    expect(isOpenAIModel('o1-preview')).toBe(true);
    expect(isOpenAIModel('o3-mini')).toBe(true);
  });

  it('does not match Workers AI models', () => {
    expect(isOpenAIModel('@cf/meta/llama-4-scout-17b-16e-instruct')).toBe(false);
    expect(isOpenAIModel('@cf/google/gemma-3-12b-it')).toBe(false);
  });

  it('does not match Anthropic models', () => {
    expect(isOpenAIModel('claude-sonnet-4-6')).toBe(false);
    expect(isOpenAIModel('claude-opus-4-6')).toBe(false);
  });
});

// =============================================================================
// Provider Detection
// =============================================================================

describe('getModelProvider', () => {
  it('returns anthropic for Claude models', () => {
    expect(getModelProvider('claude-haiku-4-5-20251001')).toBe('anthropic');
    expect(getModelProvider('claude-sonnet-4-6')).toBe('anthropic');
    expect(getModelProvider('claude-opus-4-6')).toBe('anthropic');
  });

  it('returns openai for GPT models', () => {
    expect(getModelProvider('gpt-4.1')).toBe('openai');
    expect(getModelProvider('gpt-4.1-mini')).toBe('openai');
    expect(getModelProvider('gpt-5.2')).toBe('openai');
  });

  it('returns openai for o-series models', () => {
    expect(getModelProvider('o1-preview')).toBe('openai');
    expect(getModelProvider('o3-mini')).toBe('openai');
  });

  it('returns workers-ai for @cf/ models', () => {
    expect(getModelProvider('@cf/meta/llama-4-scout-17b-16e-instruct')).toBe('workers-ai');
    expect(getModelProvider('@cf/qwen/qwen3-30b-a3b-fp8')).toBe('workers-ai');
    expect(getModelProvider('@cf/google/gemma-3-12b-it')).toBe('workers-ai');
  });

  it('returns workers-ai for unknown models', () => {
    expect(getModelProvider('unknown-model')).toBe('workers-ai');
  });
});

// =============================================================================
// Platform Model Catalog
// =============================================================================

describe('PLATFORM_AI_MODELS catalog', () => {
  // Import directly to test the catalog
  it('has correct tier assignments', async () => {
    const { PLATFORM_AI_MODELS } = await import('@simple-agent-manager/shared');

    const freeModels = PLATFORM_AI_MODELS.filter((m) => m.tier === 'free');
    const standardModels = PLATFORM_AI_MODELS.filter((m) => m.tier === 'standard');
    const premiumModels = PLATFORM_AI_MODELS.filter((m) => m.tier === 'premium');

    // All Workers AI models are free tier
    for (const m of freeModels) {
      expect(m.provider).toBe('workers-ai');
      expect(m.costPer1kInputTokens).toBe(0);
      expect(m.costPer1kOutputTokens).toBe(0);
    }

    // Standard tier has at least Haiku and GPT-4.1
    expect(standardModels.length).toBeGreaterThanOrEqual(2);

    // Premium tier has Opus and GPT-5.2
    expect(premiumModels.some((m) => m.id === 'claude-opus-4-6')).toBe(true);
    expect(premiumModels.some((m) => m.id === 'gpt-5.2')).toBe(true);
  });

  it('has exactly one default model', async () => {
    const { PLATFORM_AI_MODELS } = await import('@simple-agent-manager/shared');
    const defaults = PLATFORM_AI_MODELS.filter((m) => m.isDefault);
    expect(defaults.length).toBe(1);
  });

  it('includes all three providers', async () => {
    const { PLATFORM_AI_MODELS } = await import('@simple-agent-manager/shared');
    const providers = new Set(PLATFORM_AI_MODELS.map((m) => m.provider));
    expect(providers.has('workers-ai')).toBe(true);
    expect(providers.has('anthropic')).toBe(true);
    expect(providers.has('openai')).toBe(true);
  });

  it('has positive cost for non-free models', async () => {
    const { PLATFORM_AI_MODELS } = await import('@simple-agent-manager/shared');
    for (const m of PLATFORM_AI_MODELS) {
      if (m.tier !== 'free') {
        expect(m.costPer1kInputTokens).toBeGreaterThan(0);
        expect(m.costPer1kOutputTokens).toBeGreaterThan(0);
      }
    }
  });

  it('all model IDs are recognized by getModelProvider', async () => {
    const { PLATFORM_AI_MODELS } = await import('@simple-agent-manager/shared');
    for (const m of PLATFORM_AI_MODELS) {
      expect(getModelProvider(m.id)).toBe(m.provider);
    }
  });
});

