import type { SamConfig } from '@simple-agent-manager/shared';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runAgentLoop } from '../../../src/durable-objects/sam-session/agent-loop';
import type { Env } from '../../../src/env';
import { __resetAdminSettingsCacheForTest, updateAdminSettings } from '../../../src/services/admin-settings';
import {
  chatTargetHeaders,
  LlmUnavailableError,
  resolveWorkersAiChatTarget,
} from '../../../src/services/llm-chat-target';
import { validLlmBaseUrl } from '../../../src/services/llm-endpoint-settings';
import { generateTaskTitle } from '../../../src/services/task-title';
import { createAdminSettingsEnv } from '../../helpers/admin-settings-env';

const CLOUDFLARE = { CF_ACCOUNT_ID: 'account-1', CF_API_TOKEN: 'cf-token', AI_GATEWAY_ID: 'sam' };
const LONG_MESSAGE = 'Please refactor the billing reconciliation job so it '.repeat(10);

let sqlite: Database.Database;
let env: Env;

beforeEach(() => {
  __resetAdminSettingsCacheForTest();
  ({ sqlite, env } = createAdminSettingsEnv());
});
afterEach(() => {
  sqlite.close();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Configure the endpoint through the real admin settings writer (encrypts the key). */
async function configureEndpoint(values: Record<string, string>) {
  await updateAdminSettings(env, {
    changes: Object.entries(values).map(([key, value]) => ({
      name: `llm.openAICompatible.${key}` as never,
      value,
    })),
    actorUserId: 'admin',
  });
}

function sseResponse(chunks: string[]): Response {
  return new Response(chunks.map((chunk) => `data: ${chunk}\n\n`).join(''), {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

function writer(): WritableStreamDefaultWriter<Uint8Array> {
  return new WritableStream<Uint8Array>().getWriter();
}

describe('validLlmBaseUrl', () => {
  it.each([
    'https://llm.example.com/v1',
    'https://api.openai.com/v1/',
    'http://127.0.0.1:4000/v1',
    'http://localhost:11434/v1',
    'http://ollama:11434/v1',
    'http://192.168.1.20/v1',
    'http://10.0.0.5/v1',
    'http://172.20.0.3/v1',
    'http://[::1]:4000/v1',
    'http://[fd00::1]/v1',
  ])('accepts %s', (url) => expect(validLlmBaseUrl(url)).toBe(true));

  it.each([
    'http://llm.example.com/v1',
    'http://8.8.8.8/v1',
    'http://172.32.0.1/v1',
    // Every IPv6 literal lacks a '.', which the single-label rule must not mistake for private.
    'http://[2001:db8::1]/v1',
    'http://[::ffff:8.8.8.8]/v1',
    'http://[fe00::1]/v1',
    // Metadata services and link-local addresses, over any scheme.
    'http://[fe80::1]/v1',
    'https://169.254.169.254/v1',
    'http://metadata.google.internal/v1',
    'https://metadata/v1',
    'https://[fd00:ec2::254]/v1',
    'https://user:pass@llm.example.com/v1',
    'https://llm.example.com/v1?key=x',
    'https://llm.example.com/v1/chat/completions',
    'ftp://llm.example.com',
    '',
    42,
  ])('refuses %s', (url) => expect(validLlmBaseUrl(url)).toBe(false));
});

describe('resolveWorkersAiChatTarget', () => {
  it('keeps the Cloudflare AI Gateway route when no endpoint is configured', async () => {
    Object.assign(env, CLOUDFLARE);
    const target = await resolveWorkersAiChatTarget(env, 'taskTitle', '@cf/model/a');
    expect(target).toEqual({
      kind: 'cloudflare-gateway',
      baseUrl: 'https://gateway.ai.cloudflare.com/v1/account-1/sam/workers-ai/v1',
      url: 'https://gateway.ai.cloudflare.com/v1/account-1/sam/workers-ai/v1/chat/completions',
      apiKey: 'cf-token',
      model: '@cf/model/a',
      redirect: 'follow',
    });
  });

  it('falls back to the Workers AI REST API without a gateway id', async () => {
    Object.assign(env, { ...CLOUDFLARE, AI_GATEWAY_ID: undefined });
    expect((await resolveWorkersAiChatTarget(env, 'diagnosis', '@cf/m/x'))?.url).toBe(
      'https://api.cloudflare.com/client/v4/accounts/account-1/ai/v1/chat/completions'
    );
  });

  it('is null off Cloudflare with no endpoint (wrangler default gateway id only)', async () => {
    Object.assign(env, { AI_GATEWAY_ID: 'sam' });
    expect(await resolveWorkersAiChatTarget(env, 'aiProxy', '@cf/m/x')).toBeNull();
  });

  it('uses the configured endpoint, purpose model first, then the default model', async () => {
    Object.assign(env, CLOUDFLARE);
    await configureEndpoint({
      baseUrl: 'http://127.0.0.1:4000/v1/',
      apiKey: 'sk-endpoint-key',
      model: 'default-model',
      taskTitleModel: 'title-model',
    });
    expect(await resolveWorkersAiChatTarget(env, 'taskTitle', '@cf/m/x')).toEqual({
      kind: 'openai-compatible',
      baseUrl: 'http://127.0.0.1:4000/v1',
      url: 'http://127.0.0.1:4000/v1/chat/completions',
      apiKey: 'sk-endpoint-key',
      model: 'title-model',
      // An endpoint target never follows a redirect to a host the validation did not see.
      redirect: 'error',
    });
    expect((await resolveWorkersAiChatTarget(env, 'diagnosis', '@cf/m/x'))?.model).toBe(
      'default-model'
    );
  });

  it('sends the requested model when the endpoint has no model configured', async () => {
    await configureEndpoint({ baseUrl: 'https://llm.example.com/v1' });
    const target = await resolveWorkersAiChatTarget(env, 'aiProxy', '@cf/m/x');
    expect(target).toMatchObject({ kind: 'openai-compatible', apiKey: null, model: '@cf/m/x' });
  });

  it('stores the API key encrypted, never as plaintext', async () => {
    await configureEndpoint({ baseUrl: 'https://llm.example.com/v1', apiKey: 'sk-endpoint-key' });
    const rows = sqlite
      .prepare("SELECT encrypted_token FROM platform_credentials WHERE provider='openai-compatible'")
      .all() as { encrypted_token: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.encrypted_token).not.toContain('sk-endpoint-key');
    expect(sqlite.prepare('SELECT value FROM platform_settings').all()).not.toContainEqual(
      expect.objectContaining({ value: expect.stringContaining('sk-endpoint-key') })
    );
  });

  it('fails closed when an endpoint is configured but its key cannot be read', async () => {
    Object.assign(env, CLOUDFLARE);
    await configureEndpoint({ baseUrl: 'https://llm.example.com/v1', apiKey: 'sk-endpoint-key' });
    // A rotated ENCRYPTION_KEY makes the stored key undecryptable.
    __resetAdminSettingsCacheForTest();
    env.ENCRYPTION_KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(resolveWorkersAiChatTarget(env, 'taskTitle', '@cf/m/x')).rejects.toThrow(
      LlmUnavailableError
    );
  });

  it('keeps the Cloudflare route when no endpoint is configured, without reading credentials', async () => {
    Object.assign(env, CLOUDFLARE);
    const prepare = vi.spyOn(env.DATABASE, 'prepare');
    await resolveWorkersAiChatTarget(env, 'taskTitle', '@cf/m/x');
    const sql = prepare.mock.calls.map(([query]) => String(query)).join('\n');
    expect(sql).not.toContain('platform_credentials');
  });

  /** D1 stops answering after the settings cache expires. */
  function breakSettingsReads() {
    __resetAdminSettingsCacheForTest();
    vi.spyOn(env.DATABASE, 'prepare').mockImplementation(() => {
      throw new Error('D1 unavailable');
    });
  }

  it('refuses rather than falls back to Cloudflare when a configured endpoint becomes unreadable', async () => {
    Object.assign(env, CLOUDFLARE);
    await configureEndpoint({ baseUrl: 'https://llm.example.com/v1', apiKey: 'sk-endpoint-key' });
    // Liveness: the endpoint resolves while settings are readable.
    expect((await resolveWorkersAiChatTarget(env, 'taskTitle', '@cf/m/x'))?.kind).toBe(
      'openai-compatible'
    );
    breakSettingsReads();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const outcome = await resolveWorkersAiChatTarget(env, 'taskTitle', '@cf/m/x').catch(
      (err: unknown) => err
    );
    expect(outcome).toBeInstanceOf(LlmUnavailableError);
    expect((outcome as LlmUnavailableError).reason).toBe('settings_unreadable');
    expect((outcome as LlmUnavailableError).message).toContain('could not be read');
  });

  it('keeps the pre-endpoint Cloudflare route when an isolate that never read the setting hits an outage', async () => {
    Object.assign(env, CLOUDFLARE);
    breakSettingsReads();
    expect((await resolveWorkersAiChatTarget(env, 'taskTitle', '@cf/m/x'))?.kind).toBe(
      'cloudflare-gateway'
    );
  });

  it('keeps the Cloudflare route through an outage when the last read found no endpoint', async () => {
    Object.assign(env, CLOUDFLARE);
    expect((await resolveWorkersAiChatTarget(env, 'taskTitle', '@cf/m/x'))?.kind).toBe(
      'cloudflare-gateway'
    );
    breakSettingsReads();
    const target = await resolveWorkersAiChatTarget(env, 'taskTitle', '@cf/m/x');
    expect(target?.url).toBe(
      'https://gateway.ai.cloudflare.com/v1/account-1/sam/workers-ai/v1/chat/completions'
    );
  });

  it('tells the agent the settings are unreadable, without calling any model', async () => {
    Object.assign(env, CLOUDFLARE);
    await configureEndpoint({ baseUrl: 'https://llm.example.com/v1', apiKey: 'sk-endpoint-key' });
    await resolveWorkersAiChatTarget(env, 'agent', '@cf/m/x');
    breakSettingsReads();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const chunks: string[] = [];
    const sink = new WritableStream<Uint8Array>({
      write(chunk) {
        chunks.push(new TextDecoder().decode(chunk));
      },
    }).getWriter();

    await runAgentLoop(
      'conv-1',
      [],
      'hi',
      {
        model: '@cf/test/model',
        maxTokens: 128,
        maxTurns: 1,
        maxRequestBodyBytes: 100_000,
        maxToolResultBytes: 10_000,
        aigSource: 'sam-session',
        ftsEnabled: false,
      } as SamConfig,
      env,
      'user-1',
      sink,
      vi.fn()
    );

    expect(fetchMock).not.toHaveBeenCalled();
    const stream = chunks.join('');
    expect(stream).toContain('could not be read');
    expect(stream).toContain('"type":"done"');
  });

  it('rejects an invalid base URL at the admin settings boundary', async () => {
    await expect(configureEndpoint({ baseUrl: 'http://llm.example.com/v1' })).rejects.toThrow();
  });
});

describe('chatTargetHeaders', () => {
  it('sends gateway attribution to Cloudflare only', async () => {
    Object.assign(env, CLOUDFLARE);
    const cloudflare = await resolveWorkersAiChatTarget(env, 'aiProxy', '@cf/m/x');
    expect(chatTargetHeaders(cloudflare!, { 'cf-aig-metadata': '{"userId":"u"}' })).toEqual({
      'Content-Type': 'application/json',
      Authorization: 'Bearer cf-token',
      'cf-aig-metadata': '{"userId":"u"}',
    });
    await configureEndpoint({ baseUrl: 'https://llm.example.com/v1' });
    const endpoint = await resolveWorkersAiChatTarget(env, 'aiProxy', '@cf/m/x');
    expect(chatTargetHeaders(endpoint!, { 'cf-aig-metadata': '{"userId":"u"}' })).toEqual({
      'Content-Type': 'application/json',
    });
  });
});

describe('task titles through the real generator', () => {
  it('call the configured endpoint with its model and key, without Workers AI quirks', async () => {
    Object.assign(env, CLOUDFLARE);
    await configureEndpoint({
      baseUrl: 'https://llm.example.com/v1',
      apiKey: 'sk-endpoint-key',
      taskTitleModel: 'title-model',
    });
    const fetchMock = vi.fn(async () =>
      Response.json({ choices: [{ message: { content: 'Refactor billing job' } }] })
    );
    vi.stubGlobal('fetch', fetchMock);

    const title = await generateTaskTitle(env, LONG_MESSAGE, {
      model: '@cf/zai-org/glm-5.2',
      maxRetries: 0,
    });

    expect(title).toBe('Refactor billing job');
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://llm.example.com/v1/chat/completions');
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer sk-endpoint-key');
    expect(headers['cf-aig-metadata']).toBeUndefined();
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.model).toBe('title-model');
    expect(body).not.toHaveProperty('chat_template_kwargs');
  });

  it('keep the Cloudflare request unchanged when no endpoint is configured', async () => {
    Object.assign(env, CLOUDFLARE);
    const fetchMock = vi.fn(async () =>
      Response.json({ choices: [{ message: { content: 'Refactor billing job' } }] })
    );
    vi.stubGlobal('fetch', fetchMock);

    await generateTaskTitle(env, LONG_MESSAGE, { model: '@cf/zai-org/glm-5.2', maxRetries: 0 });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(
      'https://gateway.ai.cloudflare.com/v1/account-1/sam/workers-ai/v1/chat/completions'
    );
    expect((init.headers as Record<string, string>)['cf-aig-metadata']).toContain('task-title');
    expect(JSON.parse(String(init.body))).toMatchObject({
      model: '@cf/zai-org/glm-5.2',
      chat_template_kwargs: { enable_thinking: false },
    });
  });

  it('truncate without calling Cloudflare when the configured endpoint becomes unreadable', async () => {
    Object.assign(env, CLOUDFLARE);
    await configureEndpoint({ baseUrl: 'https://llm.example.com/v1', apiKey: 'sk-endpoint-key' });
    await resolveWorkersAiChatTarget(env, 'taskTitle', '@cf/m/x');
    __resetAdminSettingsCacheForTest();
    vi.spyOn(env.DATABASE, 'prepare').mockImplementation(() => {
      throw new Error('D1 unavailable');
    });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const title = await generateTaskTitle(env, LONG_MESSAGE, { maxRetries: 2 });

    expect(LONG_MESSAGE.startsWith(title.replace(/…$|\.\.\.$/, '').trimEnd())).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('truncate quietly when no model is available at all', async () => {
    Object.assign(env, { AI_GATEWAY_ID: 'sam' });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const warn = vi.spyOn(console, 'warn');

    const title = await generateTaskTitle(env, LONG_MESSAGE, { maxRetries: 2 });

    expect(title.length).toBeGreaterThan(0);
    expect(LONG_MESSAGE.startsWith(title.replace(/…$|\.\.\.$/, '').trimEnd())).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(warn.mock.calls.flat().join(' ')).not.toContain('task_title');
  });
});

describe('SAM and project agents through the real loop', () => {
  const config = {
    model: 'claude-sonnet-5',
    maxTokens: 128,
    maxTurns: 1,
    maxRequestBodyBytes: 100_000,
    maxToolResultBytes: 10_000,
    aigSource: 'sam-session',
    ftsEnabled: false,
  } as SamConfig;

  it('route every model to the configured endpoint with the agent model', async () => {
    Object.assign(env, CLOUDFLARE);
    await configureEndpoint({
      baseUrl: 'https://llm.example.com/v1',
      apiKey: 'sk-endpoint-key',
      model: 'default-model',
      agentModel: 'agent-model',
    });
    const fetchMock = vi.fn(async () =>
      sseResponse(['{"choices":[{"delta":{"content":"hello"}}]}', '[DONE]'])
    );
    vi.stubGlobal('fetch', fetchMock);

    await runAgentLoop('conv-1', [], 'hi', config, env, 'user-1', writer(), vi.fn());

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://llm.example.com/v1/chat/completions');
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer sk-endpoint-key');
    expect(headers['x-api-key']).toBeUndefined();
    expect(headers['cf-aig-metadata']).toBeUndefined();
    expect(JSON.parse(String(init.body))).toMatchObject({ model: 'agent-model', stream: true });
  });

  it('keep the Workers AI gateway route for @cf models when no endpoint is configured', async () => {
    Object.assign(env, CLOUDFLARE);
    const fetchMock = vi.fn(async () =>
      sseResponse(['{"choices":[{"delta":{"content":"hello"}}]}', '[DONE]'])
    );
    vi.stubGlobal('fetch', fetchMock);

    await runAgentLoop(
      'conv-1',
      [],
      'hi',
      { ...config, model: '@cf/test/model' },
      env,
      'user-1',
      writer(),
      vi.fn()
    );

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(
      'https://gateway.ai.cloudflare.com/v1/account-1/sam/workers-ai/v1/chat/completions'
    );
    expect((init.headers as Record<string, string>)['cf-aig-metadata']).toContain('sam-session');
  });

  it('tell the user no model is configured, without an error log, when nothing can serve the turn', async () => {
    Object.assign(env, { AI_GATEWAY_ID: 'sam' });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const chunks: string[] = [];
    const sink = new WritableStream<Uint8Array>({
      write(chunk) {
        chunks.push(new TextDecoder().decode(chunk));
      },
    }).getWriter();

    await runAgentLoop(
      'conv-1',
      [],
      'hi',
      { ...config, model: '@cf/test/model' },
      env,
      'user-1',
      sink,
      vi.fn()
    );

    expect(fetchMock).not.toHaveBeenCalled();
    const stream = chunks.join('');
    expect(stream).toContain('No language model is available on this installation');
    expect(stream).toContain('"type":"done"');
    expect(errors.mock.calls.flat().join(' ')).not.toContain('sam.llm_fetch_error');
  });
});

