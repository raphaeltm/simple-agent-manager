import {
  DEFAULT_CONTEXT_SUMMARY_MAX_LENGTH,
  DEFAULT_CONTEXT_SUMMARY_MAX_MESSAGES,
  DEFAULT_CONTEXT_SUMMARY_MODEL,
  DEFAULT_CONTEXT_SUMMARY_RECENT_MESSAGES,
  DEFAULT_CONTEXT_SUMMARY_SHORT_THRESHOLD,
  DEFAULT_CONTEXT_SUMMARY_TIMEOUT_MS,
} from '@simple-agent-manager/shared';
import { beforeEach,describe, expect, it, vi } from 'vitest';

import {
  buildHeuristicSummary,
  chunkMessages,
  filterMessages,
  formatMessagesForPrompt,
  getSummarizeConfig,
  type SummarizeMessage,
  summarizeSession,
  type TaskContext,
} from '../../../src/services/session-summarize';

// Mock @mastra/core/agent — use regular function (not arrow) so `new Agent(...)` works in Vitest 4
const mockGenerate = vi.fn();
vi.mock('@mastra/core/agent', () => ({
  Agent: vi.fn().mockImplementation(function () { return {
    generate: mockGenerate,
  }; }),
}));

// Mock workers-ai-provider
vi.mock('workers-ai-provider', () => ({
  createWorkersAI: vi.fn().mockReturnValue(
    vi.fn().mockReturnValue({ modelId: 'test-model' })
  ),
}));

function createMockAi(): Ai {
  return {
    run: vi.fn().mockResolvedValue({ response: 'test' }),
  } as unknown as Ai;
}

function makeMsg(role: string, content: string, createdAt = 0): SummarizeMessage {
  return { role, content, created_at: createdAt };
}

// ---------------------------------------------------------------------------
// filterMessages
// ---------------------------------------------------------------------------

describe('filterMessages', () => {
  it('keeps user and assistant messages', () => {
    const messages = [
      makeMsg('user', 'hello'),
      makeMsg('assistant', 'hi'),
      makeMsg('tool', 'tool output'),
      makeMsg('system', 'system msg'),
      makeMsg('thinking', 'hmm'),
      makeMsg('plan', 'step 1'),
      makeMsg('user', 'thanks'),
    ];
    const result = filterMessages(messages);
    expect(result).toHaveLength(3);
    expect(result.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
  });

  it('returns empty array when no user/assistant messages', () => {
    const messages = [
      makeMsg('tool', 'output'),
      makeMsg('system', 'init'),
    ];
    expect(filterMessages(messages)).toHaveLength(0);
  });

  it('handles empty input', () => {
    expect(filterMessages([])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// chunkMessages
// ---------------------------------------------------------------------------

describe('chunkMessages', () => {
  it('keeps all messages when count <= maxMessages', () => {
    const messages = Array.from({ length: 10 }, (_, i) => makeMsg('user', `msg ${i}`));
    const result = chunkMessages(messages, 50, 20);
    expect(result).toHaveLength(10);
  });

  it('chunks when count > maxMessages — keeps first 5 + last N', () => {
    const messages = Array.from({ length: 60 }, (_, i) => makeMsg('user', `msg ${i}`));
    const result = chunkMessages(messages, 50, 20);
    // first 5 + last 20 = 25
    expect(result).toHaveLength(25);
    expect(result[0]!.content).toBe('msg 0');
    expect(result[4]!.content).toBe('msg 4');
    expect(result[5]!.content).toBe('msg 40');
    expect(result[24]!.content).toBe('msg 59');
  });

  it('handles case where recentMessages exceeds available tail', () => {
    const messages = Array.from({ length: 8 }, (_, i) => makeMsg('user', `msg ${i}`));
    // maxMessages = 5, recentMessages = 20 — but only 3 messages beyond head of 5
    const result = chunkMessages(messages, 5, 20);
    expect(result).toHaveLength(8); // head 5 + tail 3 = 8 (all messages)
  });

  it('returns all messages at exact boundary', () => {
    const messages = Array.from({ length: 50 }, (_, i) => makeMsg('user', `msg ${i}`));
    const result = chunkMessages(messages, 50, 20);
    expect(result).toHaveLength(50);
  });

  it('does not produce duplicate messages when head and tail are adjacent', () => {
    const messages = Array.from({ length: 7 }, (_, i) => makeMsg('user', `msg ${i}`));
    // maxMessages = 5, headMessages = 5, recentMessages = 5 → tail = min(5, 7-5) = 2
    const result = chunkMessages(messages, 5, 5, 5);
    expect(result).toHaveLength(7); // head 5 + tail 2 = 7 (all, no duplicates)
    const contents = result.map((m) => m.content);
    expect(new Set(contents).size).toBe(contents.length); // all unique
  });
});

// ---------------------------------------------------------------------------
// formatMessagesForPrompt
// ---------------------------------------------------------------------------

describe('formatMessagesForPrompt', () => {
  it('formats messages with role labels', () => {
    const messages = [
      makeMsg('user', 'Fix the bug'),
      makeMsg('assistant', 'I found the issue'),
    ];
    const result = formatMessagesForPrompt(messages, 2);
    expect(result).toContain('User: Fix the bug');
    expect(result).toContain('Agent: I found the issue');
  });

  it('truncates long messages for large conversations (>50 filtered)', () => {
    const longContent = 'x'.repeat(500);
    const messages = [makeMsg('user', longContent)];
    const result = formatMessagesForPrompt(messages, 55); // >50 filtered → 300 char limit
    expect(result.length).toBeLessThan(310); // "User: " prefix + 300 chars max
    expect(result).toContain('...');
  });

  it('truncates at 500 chars for medium conversations (21-50 filtered)', () => {
    const longContent = 'y'.repeat(700);
    const messages = [makeMsg('user', longContent)];
    const result = formatMessagesForPrompt(messages, 30); // 20 < 30 ≤ 50 → 500 char limit
    expect(result.length).toBeLessThan(510);
    expect(result).toContain('...');
  });

  it('does not truncate short content in small conversations', () => {
    const content = 'short message';
    const messages = [makeMsg('user', content)];
    const result = formatMessagesForPrompt(messages, 5);
    expect(result).toBe('User: short message');
  });
});

// ---------------------------------------------------------------------------
// buildHeuristicSummary
// ---------------------------------------------------------------------------

describe('buildHeuristicSummary', () => {
  it('includes task context when provided', () => {
    const ctx: TaskContext = {
      title: 'Fix login bug',
      outputBranch: 'sam/fix-login',
      outputPrUrl: 'https://github.com/repo/pull/1',
    };
    const messages = [makeMsg('user', 'please fix it')];
    const result = buildHeuristicSummary(messages, ctx);
    expect(result).toContain('**Task**: Fix login bug');
    expect(result).toContain('**Branch**: sam/fix-login');
    expect(result).toContain('**PR**: https://github.com/repo/pull/1');
    expect(result).toContain('**User**: please fix it');
  });

  it('includes agent output summary when available', () => {
    const ctx: TaskContext = {
      title: 'Add tests',
      outputSummary: 'Added 5 unit tests for auth module',
    };
    const result = buildHeuristicSummary([], ctx);
    expect(result).toContain('**Agent Summary**:');
    expect(result).toContain('Added 5 unit tests for auth module');
  });

  it('limits to last 10 messages', () => {
    const messages = Array.from({ length: 15 }, (_, i) => makeMsg('user', `msg ${i}`));
    const result = buildHeuristicSummary(messages);
    // Should contain msg 5 through msg 14 (last 10)
    expect(result).toContain('msg 5');
    expect(result).toContain('msg 14');
    expect(result).not.toContain('msg 4');
  });

  it('works with empty messages and no context', () => {
    const result = buildHeuristicSummary([]);
    expect(result).toContain('## Previous Session Context');
  });
});

// ---------------------------------------------------------------------------
// getSummarizeConfig
// ---------------------------------------------------------------------------

describe('getSummarizeConfig', () => {
  it('returns defaults when no env vars set', () => {
    const config = getSummarizeConfig({});
    expect(config.model).toBe(DEFAULT_CONTEXT_SUMMARY_MODEL);
    expect(config.maxLength).toBe(DEFAULT_CONTEXT_SUMMARY_MAX_LENGTH);
    expect(config.timeoutMs).toBe(DEFAULT_CONTEXT_SUMMARY_TIMEOUT_MS);
    expect(config.maxMessages).toBe(DEFAULT_CONTEXT_SUMMARY_MAX_MESSAGES);
    expect(config.recentMessages).toBe(DEFAULT_CONTEXT_SUMMARY_RECENT_MESSAGES);
    expect(config.shortThreshold).toBe(DEFAULT_CONTEXT_SUMMARY_SHORT_THRESHOLD);
  });

  it('reads env var overrides', () => {
    const config = getSummarizeConfig({
      CONTEXT_SUMMARY_MODEL: '@cf/custom/model',
      CONTEXT_SUMMARY_MAX_LENGTH: '8000',
      CONTEXT_SUMMARY_TIMEOUT_MS: '5000',
    });
    expect(config.model).toBe('@cf/custom/model');
    expect(config.maxLength).toBe(8000);
    expect(config.timeoutMs).toBe(5000);
  });
});

// ---------------------------------------------------------------------------
// summarizeSession (integration with mocked AI)
// ---------------------------------------------------------------------------

describe('summarizeSession', () => {
  const mockAi = createMockAi();

  beforeEach(() => {
    mockGenerate.mockReset();
  });

  it('returns verbatim for very short sessions (≤ shortThreshold)', async () => {
    const messages = [
      makeMsg('user', 'Fix login'),
      makeMsg('assistant', 'Done, fixed the timeout in auth.ts'),
    ];

    const result = await summarizeSession(mockAi, messages, { shortThreshold: 5 });
    expect(result.method).toBe('verbatim');
    expect(result.messageCount).toBe(2);
    expect(result.filteredCount).toBe(2);
    expect(result.summary).toContain('Fix login');
    // Should NOT call AI
    expect(mockGenerate).not.toHaveBeenCalled();
  });

  it('calls AI for sessions above shortThreshold', async () => {
    mockGenerate.mockResolvedValueOnce({
      text: '## Original Task\nFix the auth module\n\n## Current State\nCompleted',
    });

    const messages = Array.from({ length: 10 }, (_, i) =>
      makeMsg(i % 2 === 0 ? 'user' : 'assistant', `message ${i}`)
    );

    const result = await summarizeSession(mockAi, messages, { shortThreshold: 5 });
    expect(result.method).toBe('ai');
    expect(result.summary).toContain('## Original Task');
    expect(mockGenerate).toHaveBeenCalledOnce();
  });

  it('falls back to heuristic on AI failure', async () => {
    mockGenerate.mockRejectedValueOnce(new Error('AI service unavailable'));

    const messages = Array.from({ length: 10 }, (_, i) =>
      makeMsg(i % 2 === 0 ? 'user' : 'assistant', `message ${i}`)
    );

    const result = await summarizeSession(mockAi, messages, { shortThreshold: 5 });
    expect(result.method).toBe('heuristic');
    expect(result.summary).toContain('## Previous Session Context');
  });

  it('falls back to heuristic on whitespace-only AI response', async () => {
    mockGenerate.mockResolvedValueOnce({ text: '   \n  ' });

    const messages = Array.from({ length: 10 }, (_, i) =>
      makeMsg(i % 2 === 0 ? 'user' : 'assistant', `message ${i}`)
    );

    const result = await summarizeSession(mockAi, messages, { shortThreshold: 5 });
    expect(result.method).toBe('heuristic');
  });

  it('falls back to heuristic on null AI text', async () => {
    mockGenerate.mockResolvedValueOnce({ text: null });

    const messages = Array.from({ length: 10 }, (_, i) =>
      makeMsg(i % 2 === 0 ? 'user' : 'assistant', `message ${i}`)
    );

    const result = await summarizeSession(mockAi, messages, { shortThreshold: 5 });
    expect(result.method).toBe('heuristic');
  });

  it('falls back to heuristic on empty AI response', async () => {
    mockGenerate.mockResolvedValueOnce({ text: '' });

    const messages = Array.from({ length: 10 }, (_, i) =>
      makeMsg(i % 2 === 0 ? 'user' : 'assistant', `message ${i}`)
    );

    const result = await summarizeSession(mockAi, messages, { shortThreshold: 5 });
    expect(result.method).toBe('heuristic');
  });

  it('truncates AI response exceeding maxLength', async () => {
    const longResponse = 'x'.repeat(5000);
    mockGenerate.mockResolvedValueOnce({ text: longResponse });

    const messages = Array.from({ length: 10 }, (_, i) =>
      makeMsg(i % 2 === 0 ? 'user' : 'assistant', `message ${i}`)
    );

    const result = await summarizeSession(mockAi, messages, {
      shortThreshold: 5,
      maxLength: 100,
    });
    expect(result.method).toBe('ai');
    expect(result.summary.length).toBe(100);
    expect(result.summary.endsWith('...')).toBe(true);
  });

  it('filters out tool/system messages before processing', async () => {
    mockGenerate.mockResolvedValueOnce({ text: 'Summary of session' });

    const messages = [
      makeMsg('user', 'Fix the bug'),
      makeMsg('tool', 'tool call output'),
      makeMsg('system', 'system init'),
      makeMsg('assistant', 'I found the issue'),
      makeMsg('thinking', 'let me think'),
      makeMsg('user', 'Great, also add tests'),
      makeMsg('assistant', 'Done with tests'),
      makeMsg('user', 'one more thing'),
      makeMsg('assistant', 'sure'),
      makeMsg('user', 'and another'),
      makeMsg('assistant', 'done'),
    ];

    const result = await summarizeSession(mockAi, messages, { shortThreshold: 5 });
    expect(result.messageCount).toBe(11); // total
    expect(result.filteredCount).toBe(8); // only user + assistant
    expect(result.method).toBe('ai');
  });

  it('enriches summary with task context', async () => {
    const ctx: TaskContext = {
      title: 'Fix auth timeout',
      outputBranch: 'sam/fix-auth',
    };

    // For verbatim (short session), task context should appear
    const messages = [makeMsg('user', 'Fix it'), makeMsg('assistant', 'Done')];
    const result = await summarizeSession(mockAi, messages, { shortThreshold: 5 }, ctx);
    expect(result.summary).toContain('**Task**: Fix auth timeout');
    expect(result.summary).toContain('**Branch**: sam/fix-auth');
  });
});
