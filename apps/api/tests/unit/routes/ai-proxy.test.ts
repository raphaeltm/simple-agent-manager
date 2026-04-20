/**
 * Unit tests for the AI proxy route (AI Gateway pass-through + Anthropic translation).
 *
 * Tests model ID resolution/normalization, allowlist parsing, and Anthropic model detection.
 */
import { describe, expect, it } from 'vitest';

import { isAnthropicModel, resolveModelId } from '../../../src/routes/ai-proxy';

// =============================================================================
// Model Allowlist Parsing (extracted logic test)
// =============================================================================

describe('model allowlist parsing', () => {
  /** Replicates the getAllowedModels normalization logic. */
  function parseAndNormalizeModels(raw: string): Set<string> {
    return new Set(
      raw.split(',').map((m) => m.trim()).filter(Boolean).map((m) => {
        let resolved = m;
        if (resolved.startsWith('workers-ai/')) resolved = resolved.slice('workers-ai/'.length);
        // Anthropic models don't get @cf/ prefix
        if (resolved.startsWith('claude-')) return resolved;
        if (!resolved.startsWith('@cf/') && !resolved.startsWith('@hf/')) resolved = `@cf/${resolved}`;
        return resolved;
      }),
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

  it('returns default when model is undefined (Workers AI default)', async () => {
    expect(await resolveModelId(undefined, mockEnvWorkersAI)).toBe('@cf/meta/llama-4-scout-17b-16e-instruct');
  });

  it('returns default when model is undefined (Anthropic default)', async () => {
    expect(await resolveModelId(undefined, mockEnvAnthropic)).toBe('claude-haiku-4-5-20251001');
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
});

// =============================================================================
// Anthropic Model Detection
// =============================================================================

describe('isAnthropicModel', () => {
  it('identifies Claude models', () => {
    expect(isAnthropicModel('claude-haiku-4-5-20251001')).toBe(true);
    expect(isAnthropicModel('claude-sonnet-4-5-20250514')).toBe(true);
    expect(isAnthropicModel('claude-opus-4-6')).toBe(true);
  });

  it('does not match Workers AI models', () => {
    expect(isAnthropicModel('@cf/meta/llama-4-scout-17b-16e-instruct')).toBe(false);
    expect(isAnthropicModel('@cf/qwen/qwen3-30b-a3b-fp8')).toBe(false);
  });

  it('does not match other providers', () => {
    expect(isAnthropicModel('gpt-4o')).toBe(false);
    expect(isAnthropicModel('gemini-pro')).toBe(false);
  });
});
