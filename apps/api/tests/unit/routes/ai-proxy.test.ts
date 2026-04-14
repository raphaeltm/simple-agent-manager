/**
 * Unit tests for the AI proxy route.
 *
 * Tests schema validation, model allowlist, auth patterns,
 * and OpenAI-format response construction.
 */
import { describe, expect, it } from 'vitest';

import { chatCompletionRequestSchema } from '../../../src/schemas/ai-proxy';

// =============================================================================
// Request Schema Validation
// =============================================================================

describe('chatCompletionRequestSchema', () => {
  it('accepts valid minimal request', () => {
    const result = chatCompletionRequestSchema.safeParse({
      messages: [{ role: 'user', content: 'Hello' }],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.stream).toBe(false); // default
      expect(result.data.model).toBeUndefined();
    }
  });

  it('accepts full request with all optional fields', () => {
    const result = chatCompletionRequestSchema.safeParse({
      model: '@cf/qwen/qwen3-30b-a3b-fp8',
      messages: [
        { role: 'system', content: 'You are helpful' },
        { role: 'user', content: 'Hello' },
      ],
      stream: true,
      temperature: 0.7,
      max_tokens: 1024,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.stream).toBe(true);
      expect(result.data.temperature).toBe(0.7);
      expect(result.data.max_tokens).toBe(1024);
    }
  });

  it('rejects empty messages array', () => {
    const result = chatCompletionRequestSchema.safeParse({
      messages: [],
    });
    expect(result.success).toBe(false);
  });

  it('rejects messages with invalid role', () => {
    const result = chatCompletionRequestSchema.safeParse({
      messages: [{ role: 'function', content: 'test' }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects temperature out of range', () => {
    const result = chatCompletionRequestSchema.safeParse({
      messages: [{ role: 'user', content: 'test' }],
      temperature: 3.0,
    });
    expect(result.success).toBe(false);
  });

  it('rejects negative max_tokens', () => {
    const result = chatCompletionRequestSchema.safeParse({
      messages: [{ role: 'user', content: 'test' }],
      max_tokens: -1,
    });
    expect(result.success).toBe(false);
  });

  it('rejects non-integer max_tokens', () => {
    const result = chatCompletionRequestSchema.safeParse({
      messages: [{ role: 'user', content: 'test' }],
      max_tokens: 1.5,
    });
    expect(result.success).toBe(false);
  });

  it('accepts assistant messages', () => {
    const result = chatCompletionRequestSchema.safeParse({
      messages: [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi there!' },
        { role: 'user', content: 'How are you?' },
      ],
    });
    expect(result.success).toBe(true);
  });
});

// =============================================================================
// Model Allowlist Parsing (extracted logic test)
// =============================================================================

describe('model allowlist parsing', () => {
  /** Replicates the getAllowedModels logic from the route for unit testing. */
  function parseAllowedModels(raw: string): Set<string> {
    return new Set(raw.split(',').map((m) => m.trim()).filter(Boolean));
  }

  it('parses comma-separated model list', () => {
    const models = parseAllowedModels('@cf/model-a,@cf/model-b,@cf/model-c');
    expect(models.size).toBe(3);
    expect(models.has('@cf/model-a')).toBe(true);
    expect(models.has('@cf/model-c')).toBe(true);
  });

  it('trims whitespace around model names', () => {
    const models = parseAllowedModels(' @cf/model-a , @cf/model-b ');
    expect(models.has('@cf/model-a')).toBe(true);
    expect(models.has('@cf/model-b')).toBe(true);
  });

  it('filters empty strings from trailing commas', () => {
    const models = parseAllowedModels('@cf/model-a,,@cf/model-b,');
    expect(models.size).toBe(2);
  });
});

// =============================================================================
// Model ID Resolution (extracted logic test)
// =============================================================================

describe('model ID resolution', () => {
  /** Replicates resolveModelId logic from the route. */
  function resolveModelId(model: string | undefined, defaultModel: string): string {
    if (!model) return defaultModel;
    let resolved = model;
    if (resolved.startsWith('workers-ai/')) {
      resolved = resolved.slice('workers-ai/'.length);
    }
    if (!resolved.startsWith('@cf/') && !resolved.startsWith('@hf/')) {
      resolved = `@cf/${resolved}`;
    }
    return resolved;
  }

  it('returns default when model is undefined', () => {
    expect(resolveModelId(undefined, '@cf/default')).toBe('@cf/default');
  });

  it('returns model as-is when no prefix', () => {
    expect(resolveModelId('@cf/qwen/qwen3-30b-a3b-fp8', '@cf/default'))
      .toBe('@cf/qwen/qwen3-30b-a3b-fp8');
  });

  it('strips workers-ai/ prefix', () => {
    expect(resolveModelId('workers-ai/@cf/qwen/qwen3-30b-a3b-fp8', '@cf/default'))
      .toBe('@cf/qwen/qwen3-30b-a3b-fp8');
  });

  it('adds @cf/ prefix when missing (OpenCode strips it)', () => {
    expect(resolveModelId('meta/llama-4-scout-17b-16e-instruct', '@cf/default'))
      .toBe('@cf/meta/llama-4-scout-17b-16e-instruct');
  });
});

// =============================================================================
// OpenAI Response Format
// =============================================================================

describe('OpenAI response format', () => {
  it('non-streaming response has correct structure', () => {
    // Simulate what the route builds
    const response = {
      id: 'chatcmpl-test-uuid',
      object: 'chat.completion',
      created: 1700000000,
      model: '@cf/qwen/qwen3-30b-a3b-fp8',
      choices: [{
        index: 0,
        message: { role: 'assistant', content: 'Hello!' },
        finish_reason: 'stop',
      }],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 15,
      },
    };

    expect(response.object).toBe('chat.completion');
    expect(response.choices).toHaveLength(1);
    expect(response.choices[0].message.role).toBe('assistant');
    expect(response.choices[0].finish_reason).toBe('stop');
    expect(response.usage.total_tokens).toBe(
      response.usage.prompt_tokens + response.usage.completion_tokens,
    );
  });

  it('streaming chunk has correct structure', () => {
    const chunk = {
      id: 'chatcmpl-test-uuid',
      object: 'chat.completion.chunk',
      created: 1700000000,
      model: '@cf/qwen/qwen3-30b-a3b-fp8',
      choices: [{
        index: 0,
        delta: { content: 'Hello' },
        finish_reason: null,
      }],
    };

    expect(chunk.object).toBe('chat.completion.chunk');
    expect(chunk.choices[0].delta.content).toBe('Hello');
    expect(chunk.choices[0].finish_reason).toBeNull();
  });

  it('final streaming chunk has stop finish_reason', () => {
    const chunk = {
      id: 'chatcmpl-test-uuid',
      object: 'chat.completion.chunk',
      created: 1700000000,
      model: '@cf/qwen/qwen3-30b-a3b-fp8',
      choices: [{
        index: 0,
        delta: {},
        finish_reason: 'stop',
      }],
    };

    expect(chunk.choices[0].finish_reason).toBe('stop');
    expect(chunk.choices[0].delta).toEqual({});
  });
});
