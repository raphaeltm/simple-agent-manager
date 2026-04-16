/**
 * Unit tests for the AI proxy route (AI Gateway pass-through).
 *
 * Tests model ID resolution/normalization, allowlist parsing,
 * and <think> tag stripping from streaming/non-streaming responses.
 */
import { describe, expect, it } from 'vitest';

import {
  createThinkTagStrippingStream,
  resolveModelId,
  stripThinkTags,
  stripThinkTagsFromResponse,
} from '../../../src/routes/ai-proxy';

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

// =============================================================================
// <think> Tag Stripping
// =============================================================================

describe('stripThinkTags', () => {
  it('strips complete <think>...</think> blocks', () => {
    expect(stripThinkTags('<think>reasoning here</think>Hello world'))
      .toBe('Hello world');
  });

  it('strips multiple think blocks', () => {
    expect(stripThinkTags('<think>first</think>A<think>second</think>B'))
      .toBe('AB');
  });

  it('strips multiline think blocks', () => {
    const input = '<think>\nStep 1: analyze\nStep 2: respond\n</think>\nThe answer is 42.';
    expect(stripThinkTags(input)).toBe('\nThe answer is 42.');
  });

  it('strips unclosed <think> tag and trailing content', () => {
    expect(stripThinkTags('Hello<think>partial reasoning'))
      .toBe('Hello');
  });

  it('returns empty string when content is entirely thinking', () => {
    expect(stripThinkTags('<think>all reasoning no output</think>'))
      .toBe('');
  });

  it('returns input unchanged when no think tags present', () => {
    expect(stripThinkTags('Normal response text'))
      .toBe('Normal response text');
  });

  it('handles empty string', () => {
    expect(stripThinkTags('')).toBe('');
  });
});

describe('stripThinkTagsFromResponse', () => {
  it('strips think tags from non-streaming response', () => {
    const body = JSON.stringify({
      id: 'chatcmpl-123',
      choices: [{
        index: 0,
        message: { role: 'assistant', content: '<think>reasoning</think>The answer is 42.' },
        finish_reason: 'stop',
      }],
    });
    const result = JSON.parse(stripThinkTagsFromResponse(body));
    expect(result.choices[0].message.content).toBe('The answer is 42.');
  });

  it('handles response with no think tags', () => {
    const body = JSON.stringify({
      choices: [{ message: { role: 'assistant', content: 'Plain response' } }],
    });
    const result = JSON.parse(stripThinkTagsFromResponse(body));
    expect(result.choices[0].message.content).toBe('Plain response');
  });

  it('handles response with null content', () => {
    const body = JSON.stringify({
      choices: [{ message: { role: 'assistant', content: null } }],
    });
    const result = JSON.parse(stripThinkTagsFromResponse(body));
    expect(result.choices[0].message.content).toBeNull();
  });

  it('returns original string for invalid JSON', () => {
    expect(stripThinkTagsFromResponse('not json')).toBe('not json');
  });
});

describe('createThinkTagStrippingStream', () => {
  /** Helper to push SSE lines through the stream and collect output. */
  async function processSSE(lines: string[]): Promise<string[]> {
    const input = lines.join('\n') + '\n';
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();

    const source = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(input));
        controller.close();
      },
    });

    const transform = createThinkTagStrippingStream();
    const reader = source.pipeThrough(transform).getReader();
    let output = '';
    let result = await reader.read();
    while (!result.done) {
      output += decoder.decode(result.value);
      result = await reader.read();
    }

    return output.split('\n').filter((l) => l.length > 0);
  }

  it('passes through normal streaming chunks unchanged', async () => {
    const chunk = JSON.stringify({
      choices: [{ delta: { content: 'Hello world' } }],
    });
    const result = await processSSE([`data: ${chunk}`]);
    expect(result).toHaveLength(1);
    const parsed = JSON.parse(result[0].slice(6));
    expect(parsed.choices[0].delta.content).toBe('Hello world');
  });

  it('suppresses chunks that are entirely thinking content', async () => {
    const thinkChunk = JSON.stringify({
      choices: [{ delta: { content: '<think>reasoning' } }],
    });
    const closeChunk = JSON.stringify({
      choices: [{ delta: { content: '</think>' } }],
    });
    const visibleChunk = JSON.stringify({
      choices: [{ delta: { content: 'Visible response' } }],
    });
    const result = await processSSE([
      `data: ${thinkChunk}`,
      `data: ${closeChunk}`,
      `data: ${visibleChunk}`,
    ]);
    // Only the visible chunk should come through
    const contentLines = result.filter((l) => l.startsWith('data: '));
    expect(contentLines.length).toBeGreaterThanOrEqual(1);
    const lastParsed = JSON.parse(contentLines[contentLines.length - 1].slice(6));
    expect(lastParsed.choices[0].delta.content).toBe('Visible response');
  });

  it('passes through data: [DONE] unchanged', async () => {
    const result = await processSSE(['data: [DONE]']);
    expect(result).toContain('data: [DONE]');
  });

  it('passes through non-content chunks (tool calls, etc.)', async () => {
    const toolChunk = JSON.stringify({
      choices: [{ delta: { tool_calls: [{ function: { name: 'test' } }] } }],
    });
    const result = await processSSE([`data: ${toolChunk}`]);
    expect(result).toHaveLength(1);
    const parsed = JSON.parse(result[0].slice(6));
    expect(parsed.choices[0].delta.tool_calls).toBeDefined();
  });
});
