/**
 * Unit tests for agent loop payload size management.
 *
 * Covers:
 * - truncateToolResult: capping individual tool results
 * - estimateMessagesBytes: size approximation
 * - trimMessagesToFit: progressive message trimming
 * - Config resolution for new payload size constants
 */
import {
  DEFAULT_SAM_MAX_REQUEST_BODY_BYTES,
  DEFAULT_SAM_MAX_TOOL_RESULT_BYTES,
  resolveSamConfig,
} from '@simple-agent-manager/shared';
import { describe, expect, it } from 'vitest';

import {
  estimateMessagesBytes,
  trimMessagesToFit,
  truncateToolResult,
} from '../../../src/durable-objects/sam-session/payload-size';

// ---------------------------------------------------------------------------
// Helpers to reduce test data boilerplate
// ---------------------------------------------------------------------------

/** Build a minimal assistant message with a single tool call. */
function assistantWithToolCall(callId: string, name = 'tool', args = '{}') {
  return {
    role: 'assistant' as const,
    content: null,
    tool_calls: [{ id: callId, type: 'function' as const, function: { name, arguments: args } }],
  };
}

/** Build a tool-result message. */
function toolResult(callId: string, content: string) {
  return { role: 'tool' as const, content, tool_call_id: callId };
}

// =============================================================================
// truncateToolResult
// =============================================================================

describe('truncateToolResult', () => {
  it('returns content unchanged when under the limit', () => {
    const content = 'short content';
    expect(truncateToolResult(content, 100)).toBe(content);
  });

  it('returns content unchanged when exactly at the limit', () => {
    const content = 'x'.repeat(100);
    expect(truncateToolResult(content, 100)).toBe(content);
  });

  it('truncates content over the limit with a notice', () => {
    const content = 'x'.repeat(200);
    const result = truncateToolResult(content, 100);
    expect(result).toContain('x'.repeat(100));
    expect(result).toContain('[truncated');
    expect(result).toContain('original was 200 bytes');
    expect(result).toContain('showing first 100 bytes');
  });

  it('handles empty string', () => {
    expect(truncateToolResult('', 100)).toBe('');
  });

  it('truncates large JSON-like tool results', () => {
    const largeJson = JSON.stringify({ data: 'x'.repeat(50_000) });
    const result = truncateToolResult(largeJson, 16_384);
    expect(result.length).toBeLessThan(largeJson.length);
    expect(result).toContain('[truncated');
  });
});

// =============================================================================
// estimateMessagesBytes
// =============================================================================

describe('estimateMessagesBytes', () => {
  it('returns 0 for empty array', () => {
    expect(estimateMessagesBytes([])).toBe(0);
  });

  it('accounts for message content', () => {
    const messages = [{ role: 'user' as const, content: 'hello world' }];
    // 11 chars content + 50 overhead
    expect(estimateMessagesBytes(messages)).toBe(61);
  });

  it('accounts for tool calls in assistant messages', () => {
    const messages = [assistantWithToolCall('call_1', 'search_tasks', '{"query":"test"}')];
    // 0 content + (16 args + 12 name + 50 overhead per tool_call) + 50 msg overhead
    expect(estimateMessagesBytes(messages)).toBe(0 + 16 + 12 + 50 + 50);
  });

  it('handles messages with null content', () => {
    const messages = [{ role: 'assistant' as const, content: null }];
    expect(estimateMessagesBytes(messages)).toBe(50); // just overhead
  });

  it('sums across multiple messages', () => {
    const messages = [
      { role: 'user' as const, content: 'a'.repeat(100) },
      { role: 'assistant' as const, content: 'b'.repeat(200) },
      toolResult('call_1', 'c'.repeat(300)),
    ];
    // (100 + 50) + (200 + 50) + (300 + 50) = 750
    expect(estimateMessagesBytes(messages)).toBe(750);
  });
});

// =============================================================================
// trimMessagesToFit
// =============================================================================

describe('trimMessagesToFit', () => {
  it('returns messages unchanged when under budget', () => {
    const messages = [
      { role: 'user' as const, content: 'hello' },
      { role: 'assistant' as const, content: 'hi' },
    ];
    const result = trimMessagesToFit(messages, 10_000, 100);
    expect(result).toHaveLength(2);
    expect(result[0].content).toBe('hello');
  });

  it('truncates old tool results first (pass 1)', () => {
    const longResult = 'x'.repeat(5_000);
    const messages = [
      { role: 'user' as const, content: 'q1' },
      assistantWithToolCall('c1'),
      toolResult('c1', longResult),
      // Padding to push old turn outside protected tail of 6
      { role: 'user' as const, content: 'q2' },
      { role: 'assistant' as const, content: 'a2' },
      { role: 'user' as const, content: 'q3' },
      { role: 'assistant' as const, content: 'a3' },
      { role: 'user' as const, content: 'q4' },
      { role: 'assistant' as const, content: 'a4' },
    ];
    const result = trimMessagesToFit(messages, 2_000, 0);
    expect(result).toHaveLength(9);
    expect(result[2].content!.length).toBeLessThan(longResult.length);
    expect(result[2].content).toContain('[trimmed for context budget]');
  });

  it('drops oldest complete turns when truncation is insufficient (pass 2)', () => {
    const messages = [
      { role: 'user' as const, content: 'x'.repeat(2_000) },
      { role: 'assistant' as const, content: 'x'.repeat(2_000) },
      { role: 'user' as const, content: 'x'.repeat(2_000) },
      { role: 'assistant' as const, content: 'x'.repeat(2_000) },
      { role: 'user' as const, content: 'current question' },
    ];
    const result = trimMessagesToFit(messages, 3_000, 0);
    expect(result.length).toBeLessThan(messages.length);
    expect(result[result.length - 1].content).toBe('current question');
  });

  it('never drops below 2 messages', () => {
    const messages = [
      { role: 'user' as const, content: 'x'.repeat(10_000) },
      { role: 'assistant' as const, content: 'x'.repeat(10_000) },
    ];
    const result = trimMessagesToFit(messages, 100, 0);
    expect(result.length).toBeGreaterThanOrEqual(2);
  });

  it('preserves last 6 messages from pass 1 truncation', () => {
    const messages = [
      // Old turns (outside protected tail)
      { role: 'user' as const, content: 'old question 1' },
      assistantWithToolCall('c1'),
      toolResult('c1', 'x'.repeat(3_000)),
      { role: 'user' as const, content: 'old question 2' },
      assistantWithToolCall('c1b'),
      toolResult('c1b', 'z'.repeat(3_000)),
      { role: 'user' as const, content: 'padding question' },
      // Recent turns (within last 6 — protected)
      assistantWithToolCall('c2'),
      toolResult('c2', 'y'.repeat(3_000)),
      { role: 'user' as const, content: 'q3' },
      assistantWithToolCall('c3'),
      toolResult('c3', 'w'.repeat(3_000)),
      { role: 'user' as const, content: 'final question' },
    ];

    const result = trimMessagesToFit(messages, 8_000, 0);
    expect(result).toHaveLength(13);
    // Old tool results should be truncated
    expect(result[2].content!.length).toBeLessThan(3_000);
    expect(result[5].content!.length).toBeLessThan(3_000);
    // Recent tool results should NOT be truncated
    const recentC2 = result.find((m) => m.role === 'tool' && m.tool_call_id === 'c2');
    expect(recentC2?.content).toBe('y'.repeat(3_000));
    const recentC3 = result.find((m) => m.role === 'tool' && m.tool_call_id === 'c3');
    expect(recentC3?.content).toBe('w'.repeat(3_000));
  });

  it('does not mutate the original messages array', () => {
    const original = 'x'.repeat(5_000);
    const messages = [
      { role: 'user' as const, content: 'q' },
      assistantWithToolCall('c1'),
      toolResult('c1', original),
      { role: 'user' as const, content: 'q2' },
      { role: 'assistant' as const, content: 'a2' },
    ];
    trimMessagesToFit(messages, 1_000, 0);
    expect(messages[2].content).toBe(original);
  });

  it('handles a realistic multi-tool-call conversation', () => {
    const messages = [];
    for (let i = 0; i < 10; i++) {
      messages.push({ role: 'user' as const, content: `Question ${i}` });
      messages.push(assistantWithToolCall(`call_${i}`, 'get_session_messages', '{"sessionId":"abc"}'));
      messages.push(toolResult(`call_${i}`, JSON.stringify({ data: 'x'.repeat(20_000) })));
    }
    messages.push({ role: 'user' as const, content: 'Final question' });

    const result = trimMessagesToFit(messages, 8_388_608, 20_000);
    const totalBytes = estimateMessagesBytes(result);
    expect(totalBytes).toBeLessThanOrEqual(8_388_608 - 20_000);
    expect(result[result.length - 1].content).toBe('Final question');
  });
});

// =============================================================================
// SamConfig payload size constants
// =============================================================================

describe('SamConfig payload size resolution', () => {
  it('has correct defaults for payload size constants', () => {
    expect(DEFAULT_SAM_MAX_TOOL_RESULT_BYTES).toBe(16_384);
    expect(DEFAULT_SAM_MAX_REQUEST_BODY_BYTES).toBe(8_388_608);
  });

  it('resolves payload size config from env vars', () => {
    const config = resolveSamConfig({
      SAM_MAX_TOOL_RESULT_BYTES: '32768',
      SAM_MAX_REQUEST_BODY_BYTES: '4194304',
    });
    expect(config.maxToolResultBytes).toBe(32_768);
    expect(config.maxRequestBodyBytes).toBe(4_194_304);
  });

  it('uses defaults when env vars are not set', () => {
    const config = resolveSamConfig({});
    expect(config.maxToolResultBytes).toBe(DEFAULT_SAM_MAX_TOOL_RESULT_BYTES);
    expect(config.maxRequestBodyBytes).toBe(DEFAULT_SAM_MAX_REQUEST_BODY_BYTES);
  });
});
