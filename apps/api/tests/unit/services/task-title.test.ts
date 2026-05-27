import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import {
  classifyError,
  generateTaskTitle,
  getTaskTitleConfig,
  stripMarkdown,
  type TaskTitleConfig,
  truncateTitle,
} from '../../../src/services/task-title';

function createMockEnv(overrides: Partial<Env> = {}): Env {
  return {
    CF_ACCOUNT_ID: 'account-1',
    CF_API_TOKEN: 'cf-token',
    AI_GATEWAY_ID: 'gateway-1',
    ...overrides,
  } as Env;
}

function mockGatewayTitle(text: string | null, status = 200): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content: text } }] }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function parseGatewayRequestBody(init: RequestInit): Record<string, unknown> {
  if (typeof init.body !== 'string') {
    throw new Error('Expected JSON string request body');
  }
  return JSON.parse(init.body) as Record<string, unknown>;
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
});

describe('stripMarkdown', () => {
  it('strips common markdown formatting', () => {
    expect(stripMarkdown('# **Fix `login` bug**')).toBe('Fix login bug');
  });

  it('preserves underscores in snake_case words', () => {
    expect(stripMarkdown('_Fix_ the user_name validation')).toBe('Fix the user_name validation');
  });

  it('collapses multiple spaces', () => {
    expect(stripMarkdown('Fix   the   bug')).toBe('Fix the bug');
  });
});

describe('getTaskTitleConfig', () => {
  it('returns defaults when no env vars set', () => {
    const config = getTaskTitleConfig({});
    expect(config.model).toBe('@cf/google/gemma-3-12b-it');
    expect(config.maxLength).toBe(100);
    expect(config.timeoutMs).toBe(5000);
    expect(config.enabled).toBe(true);
    expect(config.shortMessageThreshold).toBe(100);
    expect(config.maxRetries).toBe(2);
  });

  it('reads env var overrides', () => {
    const config = getTaskTitleConfig({
      TASK_TITLE_MODEL: '@cf/custom/model',
      TASK_TITLE_MAX_LENGTH: '80',
      TASK_TITLE_TIMEOUT_MS: '3000',
      TASK_TITLE_GENERATION_ENABLED: 'false',
      TASK_TITLE_SHORT_MESSAGE_THRESHOLD: '50',
      TASK_TITLE_MAX_RETRIES: '0',
    });
    expect(config.model).toBe('@cf/custom/model');
    expect(config.maxLength).toBe(80);
    expect(config.timeoutMs).toBe(3000);
    expect(config.enabled).toBe(false);
    expect(config.shortMessageThreshold).toBe(50);
    expect(config.maxRetries).toBe(0);
  });
});

describe('generateTaskTitle', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  const env = createMockEnv();

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue(mockGatewayTitle('Fix authentication timeout bug'));
    vi.stubGlobal('fetch', fetchMock);
  });

  it('returns short messages without a Gateway call', async () => {
    const result = await generateTaskTitle(env, 'Fix login bug');
    expect(result).toBe('Fix login bug');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('falls back to truncation when AI generation is disabled', async () => {
    const long = 'a'.repeat(200);
    const config: TaskTitleConfig = { enabled: false, maxLength: 100 };
    const result = await generateTaskTitle(env, long, config);
    expect(result).toBe(truncateTitle(long, 100));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('calls Workers AI through AI Gateway with metadata', async () => {
    const long =
      'I need you to refactor the authentication module to use JWT tokens. ' + 'a'.repeat(100);
    const result = await generateTaskTitle(env, long, { model: '@cf/custom/model', maxLength: 80 });

    expect(result).toBe('Fix authentication timeout bug');
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      'https://gateway.ai.cloudflare.com/v1/account-1/gateway-1/workers-ai/v1/chat/completions'
    );
    expect(init.headers).toMatchObject({
      Authorization: 'Bearer cf-token',
      'Content-Type': 'application/json',
      'cf-aig-metadata': JSON.stringify({ source: 'task-title', modelId: '@cf/custom/model' }),
    });
    expect(parseGatewayRequestBody(init)).toMatchObject({
      model: '@cf/custom/model',
      max_tokens: 80,
    });
  });

  it('strips markdown and truncates Gateway output', async () => {
    fetchMock.mockResolvedValueOnce(mockGatewayTitle('**' + 'a'.repeat(120) + '**'));
    const long = 'Generate a title for this task. ' + 'b'.repeat(100);
    const result = await generateTaskTitle(env, long, { maxLength: 50 });
    expect(result).toHaveLength(50);
    expect(result.endsWith('...')).toBe(true);
    expect(result).not.toContain('**');
  });

  it('falls back to truncation when Gateway returns empty text', async () => {
    fetchMock.mockResolvedValueOnce(mockGatewayTitle('   '));
    const long = 'Whitespace response task. ' + 'w'.repeat(100);
    const result = await generateTaskTitle(env, long);
    expect(result).toBe(truncateTitle(long, 100));
  });

  it('retries failed Gateway requests and returns a later success', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response('failed', { status: 500 }))
      .mockResolvedValueOnce(mockGatewayTitle('Retry Success Title'));
    const long = 'This task needs a retry to generate a title. ' + 'r'.repeat(100);
    const result = await generateTaskTitle(env, long, { maxRetries: 1, retryDelayMs: 1 });
    expect(result).toBe('Retry Success Title');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('falls back after all Gateway retries fail', async () => {
    fetchMock.mockResolvedValue(new Response('failed', { status: 500 }));
    const long = 'Persistent failure task. ' + 'f'.repeat(100);
    const result = await generateTaskTitle(env, long, { maxRetries: 1, retryDelayMs: 1 });
    expect(result).toBe(truncateTitle(long, 100));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('classifyError', () => {
  it('classifies TimeoutError as timeout', () => {
    expect(
      classifyError(new DOMException('The operation was aborted', 'TimeoutError')).category
    ).toBe('timeout');
  });

  it('classifies rate limit errors', () => {
    expect(classifyError(new Error('HTTP 429 Too Many Requests')).category).toBe('rate_limit');
  });

  it('classifies generic values as error', () => {
    expect(classifyError('plain string')).toEqual({ category: 'error', message: 'plain string' });
  });
});
