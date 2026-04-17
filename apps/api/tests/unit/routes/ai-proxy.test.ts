/**
 * Unit tests for the AI proxy route (AI Gateway pass-through).
 *
 * Tests model ID resolution/normalization, allowlist parsing,
 * think-tag stripping for DeepSeek R1, and metadata header construction.
 */
import { DEFAULT_AI_PROXY_ALLOWED_MODELS } from '@simple-agent-manager/shared';
import { describe, expect, it } from 'vitest';

import { needsThinkTagStripping, resolveModelId, stripThinkTags } from '../../../src/routes/ai-proxy';

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

  it('default allowed models includes all verified models', () => {
    const models = parseAndNormalizeModels(DEFAULT_AI_PROXY_ALLOWED_MODELS);
    expect(models.has('@cf/meta/llama-4-scout-17b-16e-instruct')).toBe(true);
    expect(models.has('@cf/qwen/qwen3-30b-a3b-fp8')).toBe(true);
    expect(models.has('@cf/openai/gpt-oss-120b')).toBe(true);
    expect(models.has('@cf/meta/llama-3.3-70b-instruct-fp8-fast')).toBe(true);
    expect(models.has('@cf/google/gemma-3-12b-it')).toBe(true);
  });

  it('default allowed models does NOT include DeepSeek R1', () => {
    const models = parseAndNormalizeModels(DEFAULT_AI_PROXY_ALLOWED_MODELS);
    expect(models.has('@cf/deepseek-ai/deepseek-r1-distill-qwen-32b')).toBe(false);
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

  it('round-trips all default models through strip+normalize', () => {
    // Simulates what gateway.go does: stripCFPrefix → OpenCode sends name → proxy normalizes
    const defaultModels = DEFAULT_AI_PROXY_ALLOWED_MODELS.split(',').map((m) => m.trim());
    for (const model of defaultModels) {
      // gateway.go strips @cf/ prefix
      const stripped = model.replace(/^@cf\//, '');
      // proxy normalizeModelId adds it back
      const resolved = resolveModelId(stripped, mockEnv);
      expect(resolved).toBe(model);
    }
  });
});

// =============================================================================
// Think-Tag Stripping (DeepSeek R1)
// =============================================================================

describe('needsThinkTagStripping', () => {
  it('returns true for DeepSeek R1', () => {
    expect(needsThinkTagStripping('@cf/deepseek-ai/deepseek-r1-distill-qwen-32b')).toBe(true);
  });

  it('returns false for Llama 4 Scout', () => {
    expect(needsThinkTagStripping('@cf/meta/llama-4-scout-17b-16e-instruct')).toBe(false);
  });

  it('returns false for Qwen3', () => {
    expect(needsThinkTagStripping('@cf/qwen/qwen3-30b-a3b-fp8')).toBe(false);
  });

  it('returns false for GPT OSS', () => {
    expect(needsThinkTagStripping('@cf/openai/gpt-oss-120b')).toBe(false);
  });
});

describe('stripThinkTags', () => {
  it('strips single think block', () => {
    const input = '<think>reasoning here</think>The actual answer is 42.';
    expect(stripThinkTags(input)).toBe('The actual answer is 42.');
  });

  it('strips multiple think blocks', () => {
    const input = '<think>first</think>Hello<think>second</think> world';
    expect(stripThinkTags(input)).toBe('Hello world');
  });

  it('strips multiline think blocks', () => {
    const input = '<think>\nStep 1: analyze\nStep 2: compute\n</think>The result is 7.';
    expect(stripThinkTags(input)).toBe('The result is 7.');
  });

  it('returns original text when no think tags present', () => {
    const input = 'Just a normal response.';
    expect(stripThinkTags(input)).toBe('Just a normal response.');
  });

  it('handles empty think blocks', () => {
    const input = '<think></think>Content after.';
    expect(stripThinkTags(input)).toBe('Content after.');
  });

  it('handles text that is only a think block', () => {
    const input = '<think>all reasoning</think>';
    expect(stripThinkTags(input)).toBe('');
  });
});
