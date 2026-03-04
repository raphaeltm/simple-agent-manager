import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  generateTaskTitle,
  truncateTitle,
  getTaskTitleConfig,
  type TaskTitleConfig,
} from '../../../src/services/task-title';

// Mock @mastra/core/agent — factory must not reference outer variables
vi.mock('@mastra/core/agent', () => {
  const mockGenerate = vi.fn().mockResolvedValue({ text: 'Fix authentication timeout bug' });
  return {
    Agent: vi.fn().mockImplementation(() => ({
      generate: mockGenerate,
    })),
  };
});

// Mock workers-ai-provider
vi.mock('workers-ai-provider', () => ({
  createWorkersAI: vi.fn().mockReturnValue(
    vi.fn().mockReturnValue({ modelId: 'test-model' })
  ),
}));

// Minimal mock for Ai binding
function createMockAi(): Ai {
  return {
    run: vi.fn().mockResolvedValue({ response: 'test' }),
  } as unknown as Ai;
}

describe('truncateTitle', () => {
  it('returns short messages unchanged', () => {
    expect(truncateTitle('Fix login bug', 100)).toBe('Fix login bug');
  });

  it('truncates long messages with ellipsis', () => {
    const long = 'a'.repeat(150);
    const result = truncateTitle(long, 100);
    expect(result.length).toBe(100);
    expect(result.endsWith('...')).toBe(true);
  });

  it('returns message at exact max length unchanged', () => {
    const exact = 'a'.repeat(100);
    expect(truncateTitle(exact, 100)).toBe(exact);
  });
});

describe('getTaskTitleConfig', () => {
  it('returns defaults when no env vars set', () => {
    const config = getTaskTitleConfig({});
    expect(config.model).toBe('@cf/meta/llama-3.1-8b-instruct');
    expect(config.maxLength).toBe(100);
    expect(config.timeoutMs).toBe(5000);
    expect(config.enabled).toBe(true);
  });

  it('reads env var overrides', () => {
    const config = getTaskTitleConfig({
      TASK_TITLE_MODEL: '@cf/mistral/mistral-7b-instruct-v0.2',
      TASK_TITLE_MAX_LENGTH: '80',
      TASK_TITLE_TIMEOUT_MS: '3000',
      TASK_TITLE_GENERATION_ENABLED: 'false',
    });
    expect(config.model).toBe('@cf/mistral/mistral-7b-instruct-v0.2');
    expect(config.maxLength).toBe(80);
    expect(config.timeoutMs).toBe(3000);
    expect(config.enabled).toBe(false);
  });

  it('treats any value except "false" as enabled', () => {
    expect(getTaskTitleConfig({ TASK_TITLE_GENERATION_ENABLED: 'true' }).enabled).toBe(true);
    expect(getTaskTitleConfig({ TASK_TITLE_GENERATION_ENABLED: '1' }).enabled).toBe(true);
    expect(getTaskTitleConfig({ TASK_TITLE_GENERATION_ENABLED: '' }).enabled).toBe(true);
  });
});

describe('generateTaskTitle', () => {
  let mockAi: Ai;

  beforeEach(async () => {
    mockAi = createMockAi();
    vi.clearAllMocks();

    // Reset default mock behavior
    const { Agent } = await import('@mastra/core/agent');
    (Agent as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      generate: vi.fn().mockResolvedValue({ text: 'Fix authentication timeout bug' }),
    }));

    const { createWorkersAI } = await import('workers-ai-provider');
    (createWorkersAI as unknown as ReturnType<typeof vi.fn>).mockReturnValue(
      vi.fn().mockReturnValue({ modelId: 'test-model' })
    );
  });

  it('returns short messages without AI call', async () => {
    const short = 'Fix login bug';
    const result = await generateTaskTitle(mockAi, short);
    expect(result).toBe(short);
  });

  it('returns messages at threshold length without AI call', async () => {
    const exact = 'a'.repeat(100);
    const result = await generateTaskTitle(mockAi, exact);
    expect(result).toBe(exact);
  });

  it('calls AI for long messages and returns generated title', async () => {
    const { Agent } = await import('@mastra/core/agent');
    const mockGenerate = vi.fn().mockResolvedValue({ text: 'Refactor auth module to use JWT' });
    (Agent as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      generate: mockGenerate,
    }));

    const long = 'I need you to refactor the authentication module to use JWT tokens instead of session cookies and also update the middleware to validate tokens properly. ' + 'a'.repeat(100);
    const result = await generateTaskTitle(mockAi, long);
    expect(result).toBe('Refactor auth module to use JWT');
    expect(mockGenerate).toHaveBeenCalledWith(long);
  });

  it('falls back to truncation when AI generation is disabled', async () => {
    const long = 'a'.repeat(200);
    const config: TaskTitleConfig = { enabled: false, maxLength: 100 };
    const result = await generateTaskTitle(mockAi, long, config);
    expect(result.length).toBe(100);
    expect(result.endsWith('...')).toBe(true);
  });

  it('falls back to truncation when AI returns empty response', async () => {
    const { Agent } = await import('@mastra/core/agent');
    (Agent as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      generate: vi.fn().mockResolvedValue({ text: '' }),
    }));

    const long = 'This is a very long task description that needs to be summarized. ' + 'x'.repeat(100);
    const result = await generateTaskTitle(mockAi, long);
    expect(result.length).toBeLessThanOrEqual(100);
    expect(result.endsWith('...')).toBe(true);
  });

  it('falls back to truncation when AI throws an error', async () => {
    const { Agent } = await import('@mastra/core/agent');
    (Agent as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      generate: vi.fn().mockRejectedValue(new Error('Model unavailable')),
    }));

    const long = 'Some long task description that needs AI to summarize. ' + 'y'.repeat(100);
    const result = await generateTaskTitle(mockAi, long);
    expect(result.length).toBeLessThanOrEqual(100);
    expect(result.endsWith('...')).toBe(true);
  });

  it('falls back to truncation on timeout', async () => {
    const { Agent } = await import('@mastra/core/agent');
    (Agent as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      generate: vi.fn().mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve({ text: 'Late result' }), 10000))
      ),
    }));

    const long = 'Task that takes too long to generate a title for. ' + 'z'.repeat(100);
    const config: TaskTitleConfig = { timeoutMs: 50 }; // Very short timeout
    const result = await generateTaskTitle(mockAi, long, config);
    expect(result.length).toBeLessThanOrEqual(100);
    expect(result.endsWith('...')).toBe(true);
  });

  it('truncates AI output that exceeds max length', async () => {
    const { Agent } = await import('@mastra/core/agent');
    const tooLong = 'This is a title that is way too long and exceeds the configured maximum length limit for task titles';
    (Agent as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      generate: vi.fn().mockResolvedValue({ text: tooLong }),
    }));

    const long = 'Some message that needs a title. ' + 'q'.repeat(100);
    const config: TaskTitleConfig = { maxLength: 80 };
    const result = await generateTaskTitle(mockAi, long, config);
    expect(result.length).toBeLessThanOrEqual(80);
  });

  it('trims whitespace from AI response', async () => {
    const { Agent } = await import('@mastra/core/agent');
    (Agent as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      generate: vi.fn().mockResolvedValue({ text: '  Fix the login bug  \n' }),
    }));

    const long = 'Please fix the login bug that occurs when users try to authenticate. ' + 'a'.repeat(100);
    const result = await generateTaskTitle(mockAi, long);
    expect(result).toBe('Fix the login bug');
  });

  it('uses configurable model ID', async () => {
    const { Agent } = await import('@mastra/core/agent');
    const { createWorkersAI } = await import('workers-ai-provider');
    const mockModelFactory = vi.fn().mockReturnValue({ modelId: 'custom-model' });
    (createWorkersAI as unknown as ReturnType<typeof vi.fn>).mockReturnValue(mockModelFactory);
    (Agent as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      generate: vi.fn().mockResolvedValue({ text: 'Test title' }),
    }));

    const long = 'Long message for testing model configuration. ' + 'a'.repeat(100);
    const config: TaskTitleConfig = { model: '@cf/mistral/mistral-7b-instruct-v0.2' };
    await generateTaskTitle(mockAi, long, config);
    expect(mockModelFactory).toHaveBeenCalledWith('@cf/mistral/mistral-7b-instruct-v0.2');
  });
});
