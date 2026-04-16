/**
 * Unit tests for the AI proxy route (AI Gateway pass-through).
 *
 * Tests model ID resolution/normalization and allowlist parsing.
 * Response format tests are no longer needed — the Gateway returns
 * standard OpenAI format and we pass it through transparently.
 */
import { describe, expect, it } from 'vitest';

import { resolveModelId } from '../../../src/routes/ai-proxy';

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
});

// =============================================================================
// Model ID Resolution
// =============================================================================

describe('resolveModelId', () => {
  const mockEnv = {
    AI_PROXY_DEFAULT_MODEL: '@cf/meta/llama-4-scout-17b-16e-instruct',
  } as Parameters<typeof resolveModelId>[1];

  it('returns default when model is undefined', () => {
    expect(resolveModelId(undefined, mockEnv)).toBe('@cf/meta/llama-4-scout-17b-16e-instruct');
  });

  it('returns model as-is when @cf/ prefix present', () => {
    expect(resolveModelId('@cf/qwen/qwen3-30b-a3b-fp8', mockEnv))
      .toBe('@cf/qwen/qwen3-30b-a3b-fp8');
  });

  it('strips workers-ai/ prefix', () => {
    expect(resolveModelId('workers-ai/@cf/qwen/qwen3-30b-a3b-fp8', mockEnv))
      .toBe('@cf/qwen/qwen3-30b-a3b-fp8');
  });

  it('adds @cf/ prefix when missing (OpenCode strips it)', () => {
    expect(resolveModelId('meta/llama-4-scout-17b-16e-instruct', mockEnv))
      .toBe('@cf/meta/llama-4-scout-17b-16e-instruct');
  });

  it('preserves @hf/ prefix for HuggingFace models', () => {
    expect(resolveModelId('@hf/some/model', mockEnv))
      .toBe('@hf/some/model');
  });
});
