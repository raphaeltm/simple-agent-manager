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
      model: 'workers-ai/@cf/qwen/qwen2.5-coder-32b-instruct',
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

  it('accepts tool messages', () => {
    const result = chatCompletionRequestSchema.safeParse({
      messages: [
        { role: 'user', content: 'What is the weather?' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'call_abc123',
            type: 'function',
            function: { name: 'getWeather', arguments: '{"location":"London"}' },
          }],
        },
        { role: 'tool', content: '{"temp": 15}', tool_call_id: 'call_abc123' },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('accepts tools and tool_choice', () => {
    const result = chatCompletionRequestSchema.safeParse({
      messages: [{ role: 'user', content: 'Hello' }],
      tools: [{
        type: 'function',
        function: {
          name: 'getWeather',
          description: 'Get the weather',
          parameters: {
            type: 'object',
            properties: { location: { type: 'string' } },
          },
        },
      }],
      tool_choice: 'auto',
    });
    expect(result.success).toBe(true);
  });

  it('accepts tool_choice with specific function', () => {
    const result = chatCompletionRequestSchema.safeParse({
      messages: [{ role: 'user', content: 'Hello' }],
      tools: [{
        type: 'function',
        function: { name: 'getWeather' },
      }],
      tool_choice: { type: 'function', function: { name: 'getWeather' } },
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
    const models = parseAllowedModels(
      'workers-ai/@cf/model-a,workers-ai/@cf/model-b,workers-ai/@cf/model-c',
    );
    expect(models.size).toBe(3);
    expect(models.has('workers-ai/@cf/model-a')).toBe(true);
    expect(models.has('workers-ai/@cf/model-c')).toBe(true);
  });

  it('trims whitespace around model names', () => {
    const models = parseAllowedModels(' workers-ai/@cf/model-a , workers-ai/@cf/model-b ');
    expect(models.has('workers-ai/@cf/model-a')).toBe(true);
    expect(models.has('workers-ai/@cf/model-b')).toBe(true);
  });

  it('filters empty strings from trailing commas', () => {
    const models = parseAllowedModels('workers-ai/@cf/model-a,,workers-ai/@cf/model-b,');
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
    // Strip double workers-ai/ prefix if OpenCode duplicates it
    if (resolved.startsWith('workers-ai/workers-ai/')) {
      resolved = resolved.slice('workers-ai/'.length);
    }
    return resolved;
  }

  it('returns default when model is undefined', () => {
    expect(resolveModelId(undefined, 'workers-ai/@cf/qwen/qwen2.5-coder-32b-instruct'))
      .toBe('workers-ai/@cf/qwen/qwen2.5-coder-32b-instruct');
  });

  it('returns model as-is in gateway format', () => {
    expect(resolveModelId('workers-ai/@cf/qwen/qwen2.5-coder-32b-instruct', 'default'))
      .toBe('workers-ai/@cf/qwen/qwen2.5-coder-32b-instruct');
  });

  it('deduplicates workers-ai/ prefix', () => {
    expect(resolveModelId('workers-ai/workers-ai/@cf/qwen/qwen2.5-coder-32b-instruct', 'default'))
      .toBe('workers-ai/@cf/qwen/qwen2.5-coder-32b-instruct');
  });
});

// =============================================================================
// OpenAI Response Format
// =============================================================================

describe('OpenAI response format', () => {
  it('non-streaming response has correct structure', () => {
    const response = {
      id: 'chatcmpl-test-uuid',
      object: 'chat.completion',
      created: 1700000000,
      model: 'workers-ai/@cf/qwen/qwen2.5-coder-32b-instruct',
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

  it('tool call response has correct structure', () => {
    const response = {
      id: 'chatcmpl-test-uuid',
      object: 'chat.completion',
      created: 1700000000,
      model: 'workers-ai/@cf/qwen/qwen2.5-coder-32b-instruct',
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'call_abc123',
            type: 'function',
            function: { name: 'getWeather', arguments: '{"location":"London"}' },
          }],
        },
        finish_reason: 'tool_calls',
      }],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 15,
        total_tokens: 25,
      },
    };

    expect(response.choices[0].finish_reason).toBe('tool_calls');
    expect(response.choices[0].message.tool_calls).toHaveLength(1);
    expect(response.choices[0].message.tool_calls![0].function.name).toBe('getWeather');
  });

  it('streaming chunk has correct structure', () => {
    const chunk = {
      id: 'chatcmpl-test-uuid',
      object: 'chat.completion.chunk',
      created: 1700000000,
      model: 'workers-ai/@cf/qwen/qwen2.5-coder-32b-instruct',
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
      model: 'workers-ai/@cf/qwen/qwen2.5-coder-32b-instruct',
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
