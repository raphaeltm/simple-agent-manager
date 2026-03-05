import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  generateTaskTitle,
  truncateTitle,
  stripMarkdown,
  getTaskTitleConfig,
  classifyError,
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

  it('handles maxLength of 3 (boundary of ellipsis width)', () => {
    const result = truncateTitle('hello', 3);
    expect(result).toBe('...');
  });
});

describe('stripMarkdown', () => {
  it('returns plain text unchanged', () => {
    expect(stripMarkdown('Fix authentication timeout bug')).toBe('Fix authentication timeout bug');
  });

  it('strips bold markers (**text**)', () => {
    expect(stripMarkdown('**README.md** Task Title Generator')).toBe('README.md Task Title Generator');
  });

  it('strips bold markers (__text__)', () => {
    expect(stripMarkdown('__Important__ update needed')).toBe('Important update needed');
  });

  it('strips italic markers (*text*)', () => {
    expect(stripMarkdown('*Fix* the login bug')).toBe('Fix the login bug');
  });

  it('strips italic markers (_text_) at word boundaries', () => {
    expect(stripMarkdown('_Fix_ the login bug')).toBe('Fix the login bug');
  });

  it('preserves underscores in snake_case words', () => {
    expect(stripMarkdown('Fix user_name validation')).toBe('Fix user_name validation');
  });

  it('strips heading markers (#)', () => {
    expect(stripMarkdown('# Task Title Generator')).toBe('Task Title Generator');
  });

  it('strips multiple heading levels', () => {
    expect(stripMarkdown('## Project Description')).toBe('Project Description');
    expect(stripMarkdown('### Sub Section')).toBe('Sub Section');
  });

  it('strips inline code backticks', () => {
    expect(stripMarkdown('Fix `calculateTotal` function')).toBe('Fix calculateTotal function');
  });

  it('strips fenced code blocks', () => {
    expect(stripMarkdown('Run ```npm install``` to fix')).toBe('Run npm install to fix');
  });

  it('strips link syntax keeping text', () => {
    expect(stripMarkdown('See [documentation](https://example.com) for details')).toBe('See documentation for details');
  });

  it('strips image syntax keeping alt text', () => {
    expect(stripMarkdown('Add ![logo](https://example.com/logo.png) to header')).toBe('Add logo to header');
  });

  it('strips blockquote markers', () => {
    expect(stripMarkdown('> Important note about the fix')).toBe('Important note about the fix');
  });

  it('collapses multiple spaces into single space', () => {
    expect(stripMarkdown('Fix   the   bug')).toBe('Fix the bug');
  });

  it('handles the real-world garbled title from QA testing', () => {
    const garbled = '**README.md** # Task Title Generator ## Project Description and Purpose Task Title Generator is a tool';
    const result = stripMarkdown(garbled);
    expect(result).not.toContain('**');
    expect(result).not.toMatch(/(^|\s)#+ /);
    expect(result).toBe('README.md Task Title Generator Project Description and Purpose Task Title Generator is a tool');
  });

  it('handles combined bold and heading markers', () => {
    expect(stripMarkdown('# **Important** Update')).toBe('Important Update');
  });

  it('strips horizontal rules', () => {
    expect(stripMarkdown('Title\n---\nDescription')).toBe('Title Description');
  });

  it('returns empty string for all-markdown input', () => {
    expect(stripMarkdown('## ')).toBe('');
  });

  it('trims leading and trailing whitespace', () => {
    expect(stripMarkdown('  **bold text**  ')).toBe('bold text');
  });

  it('handles empty string input', () => {
    expect(stripMarkdown('')).toBe('');
  });

  it('strips nested bold-italic markers (**_text_**)', () => {
    const result = stripMarkdown('**_Fix the bug_**');
    expect(result).toBe('Fix the bug');
    expect(result).not.toContain('*');
    expect(result).not.toContain('_');
  });

  it('strips horizontal rules (*** form)', () => {
    expect(stripMarkdown('Title\n***\nDescription')).toBe('Title Description');
  });

  it('strips horizontal rules (___ form)', () => {
    expect(stripMarkdown('Title\n___\nDescription')).toBe('Title Description');
  });

  it('strips multiline fenced code blocks keeping inner content', () => {
    const input = 'Run this:\n```\nnpm install\nnpm build\n```\nto set up';
    expect(stripMarkdown(input)).toBe('Run this: npm install npm build to set up');
  });

  it('strips _italic_ at word boundary while preserving mid-word underscores in same string', () => {
    expect(stripMarkdown('_Fix_ the user_name validation')).toBe('Fix the user_name validation');
  });
});

describe('getTaskTitleConfig', () => {
  it('returns defaults when no env vars set', () => {
    const config = getTaskTitleConfig({});
    expect(config.model).toBe('@cf/meta/llama-3.1-8b-instruct');
    expect(config.maxLength).toBe(100);
    expect(config.timeoutMs).toBe(5000);
    expect(config.enabled).toBe(true);
    expect(config.shortMessageThreshold).toBe(100);
  });

  it('reads env var overrides', () => {
    const config = getTaskTitleConfig({
      TASK_TITLE_MODEL: '@cf/mistral/mistral-7b-instruct-v0.2',
      TASK_TITLE_MAX_LENGTH: '80',
      TASK_TITLE_TIMEOUT_MS: '3000',
      TASK_TITLE_GENERATION_ENABLED: 'false',
      TASK_TITLE_SHORT_MESSAGE_THRESHOLD: '50',
    });
    expect(config.model).toBe('@cf/mistral/mistral-7b-instruct-v0.2');
    expect(config.maxLength).toBe(80);
    expect(config.timeoutMs).toBe(3000);
    expect(config.enabled).toBe(false);
    expect(config.shortMessageThreshold).toBe(50);
  });

  it('treats any value except "false" as enabled', () => {
    expect(getTaskTitleConfig({ TASK_TITLE_GENERATION_ENABLED: 'true' }).enabled).toBe(true);
    expect(getTaskTitleConfig({ TASK_TITLE_GENERATION_ENABLED: '1' }).enabled).toBe(true);
    expect(getTaskTitleConfig({ TASK_TITLE_GENERATION_ENABLED: '' }).enabled).toBe(true);
  });

  it('returns NaN for maxLength when env var is not numeric', () => {
    const config = getTaskTitleConfig({ TASK_TITLE_MAX_LENGTH: 'abc' });
    expect(Number.isNaN(config.maxLength)).toBe(true);
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

  // --- Short message bypass ---

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

  it('returns empty string without AI call', async () => {
    const { Agent } = await import('@mastra/core/agent');
    const mockGenerate = vi.fn();
    (Agent as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      generate: mockGenerate,
    }));

    const result = await generateTaskTitle(mockAi, '');
    expect(result).toBe('');
    expect(mockGenerate).not.toHaveBeenCalled();
  });

  it('short message bypasses AI even when enabled defaults to true', async () => {
    const { Agent } = await import('@mastra/core/agent');
    const mockGenerate = vi.fn();
    (Agent as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      generate: mockGenerate,
    }));

    const result = await generateTaskTitle(mockAi, 'Short message');
    expect(result).toBe('Short message');
    expect(mockGenerate).not.toHaveBeenCalled();
  });

  // --- AI generation ---

  it('calls AI for messages above threshold (101 chars)', async () => {
    const { Agent } = await import('@mastra/core/agent');
    const mockGenerate = vi.fn().mockResolvedValue({ text: 'Generated title' });
    (Agent as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      generate: mockGenerate,
    }));

    const atBoundary = 'a'.repeat(101);
    const result = await generateTaskTitle(mockAi, atBoundary);
    expect(mockGenerate).toHaveBeenCalledOnce();
    expect(result).toBe('Generated title');
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
    expect(mockGenerate).toHaveBeenCalledWith(long, expect.objectContaining({
      abortSignal: expect.any(AbortSignal),
    }));
  });

  // --- Fallback behavior ---

  it('falls back to truncation when AI generation is disabled', async () => {
    const long = 'a'.repeat(200);
    const config: TaskTitleConfig = { enabled: false, maxLength: 100 };
    const result = await generateTaskTitle(mockAi, long, config);
    expect(result).toBe(truncateTitle(long, 100));
  });

  it('falls back to truncation when AI returns empty response', async () => {
    const { Agent } = await import('@mastra/core/agent');
    (Agent as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      generate: vi.fn().mockResolvedValue({ text: '' }),
    }));

    const long = 'This is a very long task description that needs to be summarized. ' + 'x'.repeat(100);
    const result = await generateTaskTitle(mockAi, long);
    expect(result).toBe(truncateTitle(long, 100));
  });

  it('falls back to truncation when AI returns whitespace-only text', async () => {
    const { Agent } = await import('@mastra/core/agent');
    (Agent as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      generate: vi.fn().mockResolvedValue({ text: '   \n\t  ' }),
    }));

    const long = 'Whitespace AI response test. ' + 'w'.repeat(100);
    const result = await generateTaskTitle(mockAi, long);
    expect(result).toBe(truncateTitle(long, 100));
  });

  it('falls back to truncation when AI returns null text', async () => {
    const { Agent } = await import('@mastra/core/agent');
    (Agent as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      generate: vi.fn().mockResolvedValue({ text: null }),
    }));

    const long = 'Null AI response test. ' + 'n'.repeat(100);
    const result = await generateTaskTitle(mockAi, long);
    expect(result).toBe(truncateTitle(long, 100));
  });

  it('falls back to truncation when AI throws an error', async () => {
    const { Agent } = await import('@mastra/core/agent');
    (Agent as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      generate: vi.fn().mockRejectedValue(new Error('Model unavailable')),
    }));

    const long = 'Some long task description that needs AI to summarize. ' + 'y'.repeat(100);
    const result = await generateTaskTitle(mockAi, long);
    expect(result).toBe(truncateTitle(long, 100));
  });

  it('falls back to truncation when AI throws a non-Error value', async () => {
    const { Agent } = await import('@mastra/core/agent');
    (Agent as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      generate: vi.fn().mockRejectedValue('plain string rejection'),
    }));

    const long = 'Non-error rejection test. ' + 'e'.repeat(100);
    const result = await generateTaskTitle(mockAi, long);
    expect(result).toBe(truncateTitle(long, 100));
  });

  it('falls back to truncation on timeout', async () => {
    const { Agent } = await import('@mastra/core/agent');
    // Mock generate that respects AbortSignal (as the real implementation would)
    (Agent as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      generate: vi.fn().mockImplementation((_msg: string, options?: { abortSignal?: AbortSignal }) => {
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => resolve({ text: 'Late result' }), 10000);
          if (options?.abortSignal) {
            options.abortSignal.addEventListener('abort', () => {
              clearTimeout(timer);
              reject(options.abortSignal!.reason ?? new Error('Aborted'));
            });
          }
        });
      }),
    }));

    const long = 'Task that takes too long to generate a title for. ' + 'z'.repeat(100);
    const config: TaskTitleConfig = { timeoutMs: 50 }; // Very short timeout
    const result = await generateTaskTitle(mockAi, long, config);
    expect(result).toBe(truncateTitle(long, 100));
  });

  // --- Output enforcement ---

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

  it('returns AI output at exactly maxLength without truncation', async () => {
    const { Agent } = await import('@mastra/core/agent');
    const exact = 'a'.repeat(80);
    (Agent as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      generate: vi.fn().mockResolvedValue({ text: exact }),
    }));

    const long = 'Some message. ' + 'q'.repeat(100);
    const config: TaskTitleConfig = { maxLength: 80 };
    const result = await generateTaskTitle(mockAi, long, config);
    expect(result).toBe(exact);
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

  // --- Configuration ---

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

  it('uses configurable short message threshold', async () => {
    const { Agent } = await import('@mastra/core/agent');
    const mockGenerate = vi.fn().mockResolvedValue({ text: 'Generated' });
    (Agent as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      generate: mockGenerate,
    }));

    // Message of 60 chars — below default threshold (100) but above custom threshold (50)
    const message = 'a'.repeat(60);
    const config: TaskTitleConfig = { shortMessageThreshold: 50 };
    await generateTaskTitle(mockAi, message, config);
    expect(mockGenerate).toHaveBeenCalled();
  });

  it('forwards binding to createWorkersAI', async () => {
    const { createWorkersAI } = await import('workers-ai-provider');
    const { Agent } = await import('@mastra/core/agent');
    (Agent as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      generate: vi.fn().mockResolvedValue({ text: 'Title' }),
    }));

    const long = 'Test binding forwarding. ' + 'b'.repeat(100);
    await generateTaskTitle(mockAi, long);
    expect(createWorkersAI).toHaveBeenCalledWith({ binding: mockAi });
  });

  // --- Markdown stripping integration ---

  it('strips markdown formatting from AI-generated titles', async () => {
    const { Agent } = await import('@mastra/core/agent');
    (Agent as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      generate: vi.fn().mockResolvedValue({ text: '**README.md** # Task Title Generator ## Project Description' }),
    }));

    const long = 'Write a comprehensive README.md for the project. ' + 'a'.repeat(100);
    const result = await generateTaskTitle(mockAi, long);
    expect(result).not.toContain('**');
    expect(result).not.toMatch(/(^|\s)#+ /);
    expect(result).toBe('README.md Task Title Generator Project Description');
  });

  it('strips bold markers from AI-generated titles', async () => {
    const { Agent } = await import('@mastra/core/agent');
    (Agent as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      generate: vi.fn().mockResolvedValue({ text: '**Create** Upgrade Plan' }),
    }));

    const long = 'Create an upgrade plan for all project dependencies. ' + 'a'.repeat(100);
    const result = await generateTaskTitle(mockAi, long);
    expect(result).toBe('Create Upgrade Plan');
  });

  it('strips backticks from AI-generated titles', async () => {
    const { Agent } = await import('@mastra/core/agent');
    (Agent as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      generate: vi.fn().mockResolvedValue({ text: 'Fix `calculateTotal` Function Bug' }),
    }));

    const long = 'The calculateTotal function in the billing module is broken. ' + 'a'.repeat(100);
    const result = await generateTaskTitle(mockAi, long);
    expect(result).toBe('Fix calculateTotal Function Bug');
  });

  it('falls back to truncation when title is empty after markdown stripping', async () => {
    const { Agent } = await import('@mastra/core/agent');
    (Agent as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      generate: vi.fn().mockResolvedValue({ text: '## ' }),
    }));

    const long = 'Some task description that needs a title. ' + 'x'.repeat(100);
    const result = await generateTaskTitle(mockAi, long);
    expect(result).toBe(truncateTitle(long, 100));
  });

  it('includes no-markdown directive in system instructions (prevention layer)', async () => {
    const { Agent } = await import('@mastra/core/agent');
    let capturedInstructions = '';
    (Agent as unknown as ReturnType<typeof vi.fn>).mockImplementation((config: { instructions: string }) => {
      capturedInstructions = config.instructions;
      return { generate: vi.fn().mockResolvedValue({ text: 'Title' }) };
    });

    const long = 'Test instructions content. ' + 'i'.repeat(100);
    await generateTaskTitle(mockAi, long);
    expect(capturedInstructions).toContain('No markdown formatting');
  });

  it('substitutes maxLength into system instructions', async () => {
    const { Agent } = await import('@mastra/core/agent');
    let capturedInstructions = '';
    (Agent as unknown as ReturnType<typeof vi.fn>).mockImplementation((config: { instructions: string }) => {
      capturedInstructions = config.instructions;
      return { generate: vi.fn().mockResolvedValue({ text: 'Title' }) };
    });

    const long = 'Test instructions substitution. ' + 'i'.repeat(100);
    const config: TaskTitleConfig = { maxLength: 75 };
    await generateTaskTitle(mockAi, long, config);
    expect(capturedInstructions).toContain('75');
    expect(capturedInstructions).not.toContain('{maxLength}');
  });

  // --- Retry behavior ---

  it('retries on first failure and returns title on second attempt', async () => {
    const { Agent } = await import('@mastra/core/agent');
    let callCount = 0;
    (Agent as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      generate: vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return Promise.reject(new Error('Model unavailable'));
        }
        return Promise.resolve({ text: 'Retry Success Title' });
      }),
    }));

    const long = 'This task needs a retry to generate a title. ' + 'r'.repeat(100);
    const config: TaskTitleConfig = { maxRetries: 2, retryDelayMs: 10 }; // Fast retry for tests
    const result = await generateTaskTitle(mockAi, long, config);
    expect(result).toBe('Retry Success Title');
    expect(callCount).toBe(2);
  });

  it('falls back to truncation after all retries exhausted', async () => {
    const { Agent } = await import('@mastra/core/agent');
    let callCount = 0;
    (Agent as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      generate: vi.fn().mockImplementation(() => {
        callCount++;
        return Promise.reject(new Error('Persistent failure'));
      }),
    }));

    const long = 'Task that fails every attempt. ' + 'f'.repeat(100);
    const config: TaskTitleConfig = { maxRetries: 2, retryDelayMs: 10 };
    const result = await generateTaskTitle(mockAi, long, config);
    expect(result).toBe(truncateTitle(long, 100));
    // 1 initial + 2 retries = 3 total attempts
    expect(callCount).toBe(3);
  });

  it('does not retry on timeout — falls back immediately', async () => {
    const { Agent } = await import('@mastra/core/agent');
    let callCount = 0;
    (Agent as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      generate: vi.fn().mockImplementation((_msg: string, options?: { abortSignal?: AbortSignal }) => {
        callCount++;
        // Simulate timeout on every attempt
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => resolve({ text: 'Late' }), 10000);
          if (options?.abortSignal) {
            options.abortSignal.addEventListener('abort', () => {
              clearTimeout(timer);
              reject(options.abortSignal!.reason ?? new Error('Aborted'));
            });
          }
        });
      }),
    }));

    const long = 'Task that times out. ' + 't'.repeat(100);
    const config: TaskTitleConfig = { timeoutMs: 50, maxRetries: 2, retryDelayMs: 10 };
    const result = await generateTaskTitle(mockAi, long, config);
    expect(result).toBe(truncateTitle(long, 100));
    // Only 1 attempt — timeouts are not retried
    expect(callCount).toBe(1);
  });

  it('retries on rate limit error then succeeds', async () => {
    const { Agent } = await import('@mastra/core/agent');
    let callCount = 0;
    (Agent as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      generate: vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return Promise.reject(new Error('Rate limit exceeded'));
        }
        return Promise.resolve({ text: 'Rate Limit Recovery Title' });
      }),
    }));

    const long = 'Task that hits rate limit on first try. ' + 'r'.repeat(100);
    const config: TaskTitleConfig = { maxRetries: 1, retryDelayMs: 10 };
    const result = await generateTaskTitle(mockAi, long, config);
    expect(result).toBe('Rate Limit Recovery Title');
    expect(callCount).toBe(2);
  });

  it('does not retry on empty AI response — falls back immediately', async () => {
    const { Agent } = await import('@mastra/core/agent');
    let callCount = 0;
    (Agent as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      generate: vi.fn().mockImplementation(() => {
        callCount++;
        return Promise.resolve({ text: '' });
      }),
    }));

    const long = 'Task where AI gives empty answer. ' + 'e'.repeat(100);
    const config: TaskTitleConfig = { maxRetries: 2, retryDelayMs: 10 };
    const result = await generateTaskTitle(mockAi, long, config);
    expect(result).toBe(truncateTitle(long, 100));
    expect(callCount).toBe(1); // No retry on empty response
  });

  it('falls back when first attempt throws and retry returns empty string', async () => {
    const { Agent } = await import('@mastra/core/agent');
    let callCount = 0;
    (Agent as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      generate: vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) return Promise.reject(new Error('Transient fail'));
        return Promise.resolve({ text: '' }); // Empty on retry
      }),
    }));

    const long = 'Task where retry gives empty result. ' + 'x'.repeat(100);
    const config: TaskTitleConfig = { maxRetries: 2, retryDelayMs: 10 };
    const result = await generateTaskTitle(mockAi, long, config);
    expect(result).toBe(truncateTitle(long, 100));
    expect(callCount).toBe(2); // Threw once, returned empty on second attempt
  });

  it('caps retry delay at retryMaxDelayMs', async () => {
    const { Agent } = await import('@mastra/core/agent');
    let callCount = 0;
    (Agent as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      generate: vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount <= 3) return Promise.reject(new Error('Fail'));
        return Promise.resolve({ text: 'Success After Many Retries' });
      }),
    }));

    const long = 'Task with capped delay. ' + 'c'.repeat(100);
    // Base 100ms, max 150ms: delays would be 100, 150 (capped from 200), 150 (capped from 400)
    const config: TaskTitleConfig = { maxRetries: 3, retryDelayMs: 100, retryMaxDelayMs: 150 };
    const result = await generateTaskTitle(mockAi, long, config);
    expect(result).toBe('Success After Many Retries');
    expect(callCount).toBe(4);
  });

  it('does not retry when maxRetries is 0', async () => {
    const { Agent } = await import('@mastra/core/agent');
    let callCount = 0;
    (Agent as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      generate: vi.fn().mockImplementation(() => {
        callCount++;
        return Promise.reject(new Error('Fail'));
      }),
    }));

    const long = 'No retry task. ' + 'n'.repeat(100);
    const config: TaskTitleConfig = { maxRetries: 0 };
    const result = await generateTaskTitle(mockAi, long, config);
    expect(result).toBe(truncateTitle(long, 100));
    expect(callCount).toBe(1);
  });
});

describe('classifyError', () => {
  it('classifies TimeoutError as timeout', () => {
    const err = new DOMException('The operation was aborted', 'TimeoutError');
    const result = classifyError(err);
    expect(result.category).toBe('timeout');
  });

  it('classifies AbortError as timeout', () => {
    const err = new DOMException('The operation was aborted', 'AbortError');
    const result = classifyError(err);
    expect(result.category).toBe('timeout');
  });

  it('classifies error with "timeout" in message as timeout', () => {
    const err = new Error('Request timeout after 5000ms');
    const result = classifyError(err);
    expect(result.category).toBe('timeout');
  });

  it('classifies error with "rate limit" in message as rate_limit', () => {
    const err = new Error('Rate limit exceeded');
    const result = classifyError(err);
    expect(result.category).toBe('rate_limit');
  });

  it('classifies error with "429" in message as rate_limit', () => {
    const err = new Error('HTTP 429 Too Many Requests');
    const result = classifyError(err);
    expect(result.category).toBe('rate_limit');
  });

  it('classifies error with "too many requests" in message as rate_limit', () => {
    const err = new Error('too many requests, please slow down');
    const result = classifyError(err);
    expect(result.category).toBe('rate_limit');
  });

  it('classifies generic Error as error', () => {
    const err = new Error('Something went wrong');
    const result = classifyError(err);
    expect(result.category).toBe('error');
    expect(result.message).toBe('Something went wrong');
  });

  it('classifies non-Error values as error', () => {
    const result = classifyError('plain string');
    expect(result.category).toBe('error');
    expect(result.message).toBe('plain string');
  });

  it('classifies null as error', () => {
    const result = classifyError(null);
    expect(result.category).toBe('error');
    expect(result.message).toBe('null');
  });
});

describe('getTaskTitleConfig (retry config)', () => {
  it('returns default retry values when no env vars set', () => {
    const config = getTaskTitleConfig({});
    expect(config.maxRetries).toBe(2);
    expect(config.retryDelayMs).toBe(1000);
    expect(config.retryMaxDelayMs).toBe(4000);
  });

  it('reads retry env var overrides', () => {
    const config = getTaskTitleConfig({
      TASK_TITLE_MAX_RETRIES: '3',
      TASK_TITLE_RETRY_DELAY_MS: '500',
      TASK_TITLE_RETRY_MAX_DELAY_MS: '2000',
    });
    expect(config.maxRetries).toBe(3);
    expect(config.retryDelayMs).toBe(500);
    expect(config.retryMaxDelayMs).toBe(2000);
  });

  it('reads zero retries from env', () => {
    const config = getTaskTitleConfig({
      TASK_TITLE_MAX_RETRIES: '0',
    });
    expect(config.maxRetries).toBe(0);
  });
});
