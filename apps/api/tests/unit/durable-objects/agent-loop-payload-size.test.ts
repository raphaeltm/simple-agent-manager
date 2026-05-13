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
} from '../../../src/durable-objects/sam-session/agent-loop';

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
    const messages = [
      { role: 'user' as const, content: 'hello world' },
    ];
    const estimate = estimateMessagesBytes(messages);
    // 11 chars content + 50 overhead
    expect(estimate).toBe(61);
  });

  it('accounts for tool calls in assistant messages', () => {
    const messages = [
      {
        role: 'assistant' as const,
        content: null,
        tool_calls: [{
          id: 'call_1',
          type: 'function' as const,
          function: { name: 'search_tasks', arguments: '{"query":"test"}' },
        }],
      },
    ];
    const estimate = estimateMessagesBytes(messages);
    // 0 content + (16 args + 12 name + 50 overhead per tool_call) + 50 msg overhead
    expect(estimate).toBe(0 + 16 + 12 + 50 + 50);
  });

  it('handles messages with null content', () => {
    const messages = [
      { role: 'assistant' as const, content: null },
    ];
    const estimate = estimateMessagesBytes(messages);
    expect(estimate).toBe(50); // just overhead
  });

  it('sums across multiple messages', () => {
    const messages = [
      { role: 'user' as const, content: 'a'.repeat(100) },
      { role: 'assistant' as const, content: 'b'.repeat(200) },
      { role: 'tool' as const, content: 'c'.repeat(300), tool_call_id: 'call_1' },
    ];
    const estimate = estimateMessagesBytes(messages);
    // (100 + 50) + (200 + 50) + (300 + 50) = 750
    expect(estimate).toBe(750);
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
      // Old turn (outside protected tail of 6)
      { role: 'user' as const, content: 'q1' },
      { role: 'assistant' as const, content: null, tool_calls: [{ id: 'c1', type: 'function' as const, function: { name: 'tool', arguments: '{}' } }] },
      { role: 'tool' as const, content: longResult, tool_call_id: 'c1' },
      // Padding messages to push old turn outside protected tail
      { role: 'user' as const, content: 'q2' },
      { role: 'assistant' as const, content: 'a2' },
      { role: 'user' as const, content: 'q3' },
      { role: 'assistant' as const, content: 'a3' },
      { role: 'user' as const, content: 'q4' },
      { role: 'assistant' as const, content: 'a4' },
    ];
    // Total estimate ~5520 bytes. Budget of 2000 forces pass 1 truncation.
    // After truncating the 5000-char tool result to ~530, total drops to ~1050 which fits.
    const result = trimMessagesToFit(messages, 2_000, 0);
    expect(result).toHaveLength(9);
    // The old tool result should be truncated
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
    // Very tight budget — should drop oldest turns
    const result = trimMessagesToFit(messages, 3_000, 0);
    expect(result.length).toBeLessThan(messages.length);
    // The most recent user message should always be preserved
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
    // 13 messages total. Protected tail = 6, so truncateLimit = 13-6 = 7.
    // Messages at indices 0-6 are candidates; indices 7-12 are protected.
    const messages = [
      // Old turn 1 (indices 0-2, outside protected tail)
      { role: 'user' as const, content: 'old question 1' },
      { role: 'assistant' as const, content: null, tool_calls: [{ id: 'c1', type: 'function' as const, function: { name: 'tool', arguments: '{}' } }] },
      { role: 'tool' as const, content: 'x'.repeat(3_000), tool_call_id: 'c1' },
      // Old turn 2 (indices 3-5, outside protected tail)
      { role: 'user' as const, content: 'old question 2' },
      { role: 'assistant' as const, content: null, tool_calls: [{ id: 'c1b', type: 'function' as const, function: { name: 'tool', arguments: '{}' } }] },
      { role: 'tool' as const, content: 'z'.repeat(3_000), tool_call_id: 'c1b' },
      // Padding (index 6, outside protected tail)
      { role: 'user' as const, content: 'padding question' },
      // Recent turn 1 (indices 7-9, within last 6, should NOT be truncated by pass 1)
      { role: 'assistant' as const, content: null, tool_calls: [{ id: 'c2', type: 'function' as const, function: { name: 'tool', arguments: '{}' } }] },
      { role: 'tool' as const, content: 'y'.repeat(3_000), tool_call_id: 'c2' },
      { role: 'user' as const, content: 'q3' },
      // Recent turn 2 (indices 10-12, within last 6)
      { role: 'assistant' as const, content: null, tool_calls: [{ id: 'c3', type: 'function' as const, function: { name: 'tool', arguments: '{}' } }] },
      { role: 'tool' as const, content: 'w'.repeat(3_000), tool_call_id: 'c3' },
      { role: 'user' as const, content: 'final question' },
    ];

    // Budget that requires pass 1 truncation but not pass 2
    const result = trimMessagesToFit(messages, 8_000, 0);
    expect(result).toHaveLength(13);
    // The old tool results (indices 2 and 5) should be truncated
    expect(result[2].content!.length).toBeLessThan(3_000);
    expect(result[5].content!.length).toBeLessThan(3_000);
    // Recent tool results (within protected tail) should NOT be truncated
    const recentToolC2 = result.find((m) => m.role === 'tool' && m.tool_call_id === 'c2');
    expect(recentToolC2?.content).toBe('y'.repeat(3_000));
    const recentToolC3 = result.find((m) => m.role === 'tool' && m.tool_call_id === 'c3');
    expect(recentToolC3?.content).toBe('w'.repeat(3_000));
  });

  it('does not mutate the original messages array', () => {
    const original = 'x'.repeat(5_000);
    const messages = [
      { role: 'user' as const, content: 'q' },
      { role: 'assistant' as const, content: null, tool_calls: [{ id: 'c1', type: 'function' as const, function: { name: 'tool', arguments: '{}' } }] },
      { role: 'tool' as const, content: original, tool_call_id: 'c1' },
      { role: 'user' as const, content: 'q2' },
      { role: 'assistant' as const, content: 'a2' },
    ];
    trimMessagesToFit(messages, 1_000, 0);
    // Original message should be untouched
    expect(messages[2].content).toBe(original);
  });

  it('handles a realistic multi-tool-call conversation', () => {
    const messages = [];
    // Build a conversation with 10 tool call turns, each with 20KB results
    for (let i = 0; i < 10; i++) {
      messages.push({ role: 'user' as const, content: `Question ${i}` });
      messages.push({
        role: 'assistant' as const,
        content: null,
        tool_calls: [{
          id: `call_${i}`,
          type: 'function' as const,
          function: { name: 'get_session_messages', arguments: '{"sessionId":"abc"}' },
        }],
      });
      messages.push({
        role: 'tool' as const,
        content: JSON.stringify({ data: 'x'.repeat(20_000) }),
        tool_call_id: `call_${i}`,
      });
    }
    messages.push({ role: 'user' as const, content: 'Final question' });

    // 8MB budget with some overhead — should fit after trimming
    const result = trimMessagesToFit(messages, 8_388_608, 20_000);
    const totalBytes = estimateMessagesBytes(result);
    expect(totalBytes).toBeLessThanOrEqual(8_388_608 - 20_000);
    // Last message must be preserved
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
