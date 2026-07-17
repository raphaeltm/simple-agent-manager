import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import {
  readSafeGatewayErrorDiagnostic,
  WorkersAIGatewayError,
} from '../../../src/services/ai-proxy-shared';
import {
  classifyError,
  generateTaskTitle,
  getTaskTitleConfig,
  getTaskTitleModelControls,
  resolveTaskTitleErrorDiagnosticMaxLength,
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
    expect(config.model).toBe('@cf/zai-org/glm-5.2');
    expect(config.maxLength).toBe(100);
    expect(config.timeoutMs).toBe(5000);
    expect(config.enabled).toBe(true);
    expect(config.shortMessageThreshold).toBe(100);
    expect(config.maxRetries).toBe(2);
    expect(config.errorDiagnosticMaxLength).toBe(512);
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

  it('bounds invalid and excessive diagnostic length configuration', () => {
    expect(
      getTaskTitleConfig({ TASK_TITLE_ERROR_DIAGNOSTIC_MAX_LENGTH: 'invalid' })
        .errorDiagnosticMaxLength
    ).toBe(512);
    expect(
      getTaskTitleConfig({ TASK_TITLE_ERROR_DIAGNOSTIC_MAX_LENGTH: '1' }).errorDiagnosticMaxLength
    ).toBe(64);
    expect(
      getTaskTitleConfig({ TASK_TITLE_ERROR_DIAGNOSTIC_MAX_LENGTH: '999999' })
        .errorDiagnosticMaxLength
    ).toBe(2048);
    expect(resolveTaskTitleErrorDiagnosticMaxLength(Number.POSITIVE_INFINITY)).toBe(512);
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
    const result = await generateTaskTitle(env, long, {
      model: '@cf/zai-org/glm-5.2',
      maxLength: 80,
    });

    expect(result).toBe('Fix authentication timeout bug');
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      'https://gateway.ai.cloudflare.com/v1/account-1/gateway-1/workers-ai/v1/chat/completions'
    );
    expect(init.headers).toMatchObject({
      Authorization: 'Bearer cf-token',
      'Content-Type': 'application/json',
      'cf-aig-metadata': JSON.stringify({ source: 'task-title', modelId: '@cf/zai-org/glm-5.2' }),
    });
    expect(parseGatewayRequestBody(init)).toMatchObject({
      model: '@cf/zai-org/glm-5.2',
      max_tokens: 80,
      chat_template_kwargs: { enable_thinking: false },
    });
    expect(parseGatewayRequestBody(init)).not.toHaveProperty('reasoning_effort');
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

  it('uses the GLM-5.2 non-thinking capability without a null reasoning field', () => {
    expect(getTaskTitleModelControls('@cf/zai-org/glm-5.2')).toEqual({
      chatTemplateKwargs: { enable_thinking: false },
    });
  });

  it('does not retry deterministic HTTP 400 rejections and falls back', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          error: {
            code: 'invalid_parameter',
            param: 'reasoning_effort',
            message: 'reasoning_effort must not be null',
          },
        }),
        { status: 400 }
      )
    );
    const long = 'Deterministic invalid payload. ' + 'x'.repeat(120);
    const result = await generateTaskTitle(env, long, { maxRetries: 2, retryDelayMs: 1 });
    expect(result).toBe(truncateTitle(long, 100));
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('retries HTTP 429 and returns a later success', async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { code: 'rate_limit' } }), { status: 429 })
      )
      .mockResolvedValueOnce(mockGatewayTitle('Rate Limit Recovery'));
    const long = 'Rate limited title request. ' + 'r'.repeat(120);
    await expect(generateTaskTitle(env, long, { maxRetries: 1, retryDelayMs: 1 })).resolves.toBe(
      'Rate Limit Recovery'
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('retries transient HTTP 408 responses', async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { code: 'request_timeout' } }), { status: 408 })
      )
      .mockResolvedValueOnce(mockGatewayTitle('Timeout Response Recovery'));
    const long = 'Transient HTTP timeout response. ' + 'r'.repeat(120);
    await expect(generateTaskTitle(env, long, { maxRetries: 1, retryDelayMs: 1 })).resolves.toBe(
      'Timeout Response Recovery'
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not retry timeouts and falls back', async () => {
    fetchMock.mockRejectedValue(new DOMException('The operation timed out', 'TimeoutError'));
    const long = 'Timeout title request. ' + 't'.repeat(120);
    await expect(generateTaskTitle(env, long, { maxRetries: 2, retryDelayMs: 1 })).resolves.toBe(
      truncateTitle(long, 100)
    );
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});

describe('safe Gateway diagnostics', () => {
  it('keeps only bounded allowlisted error fields and genericizes messages', async () => {
    const diagnostic = await readSafeGatewayErrorDiagnostic(
      new Response(
        JSON.stringify({
          error: {
            code: 'invalid_parameter',
            type: 'invalid_request_error',
            param: 'reasoning_effort',
            message: 'reasoning_effort must not be null; prompt was sensitive task text',
            request: 'sensitive task text',
          },
          headers: { authorization: 'Bearer secret-token-value' },
        })
      ),
      512
    );
    expect(diagnostic).toBe(
      'code=invalid_parameter type=invalid_request_error param=reasoning_effort message=invalid reasoning_effort parameter'
    );
    expect(diagnostic).not.toContain('sensitive task text');
    expect(diagnostic).not.toContain('secret-token-value');
  });

  it('drops arbitrary text and respects the configured bound', async () => {
    await expect(
      readSafeGatewayErrorDiagnostic(new Response('prompt and token echoed here'), 32)
    ).resolves.toBeUndefined();
    const diagnostic = await readSafeGatewayErrorDiagnostic(
      new Response(
        JSON.stringify({
          error: { code: 'x'.repeat(100), message: 'unknown rejection with user content' },
        })
      ),
      24
    );
    expect(diagnostic).toBeUndefined();
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

  it('classifies deterministic Gateway 400s as request errors', () => {
    expect(classifyError(new WorkersAIGatewayError(400, 'param=reasoning_effort')).category).toBe(
      'request'
    );
  });

  it('classifies transient Gateway 500s as errors', () => {
    expect(classifyError(new WorkersAIGatewayError(500, undefined)).category).toBe('error');
  });

  it('classifies generic values as error', () => {
    expect(classifyError('plain string')).toEqual({ category: 'error', message: 'plain string' });
  });
});
