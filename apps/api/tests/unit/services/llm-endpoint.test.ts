import * as capabilities from '../../../src/services/platform-capabilities';
import { resolveOperatorModel } from '../../../src/durable-objects/sam-session/operator/model';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import { createRequestScopedD1 } from '../../../src/lib/d1-session';
import { forwardToWorkersAI } from '../../../src/routes/ai-proxy-upstream';
import {
  __resetAdminSettingsCacheForTest,
  invalidateAdminSettings,
  updateAdminSettings,
} from '../../../src/services/admin-settings';
import { isAiProxyEnabled } from '../../../src/services/ai-proxy-availability';
import { fetchWorkersAIChatCompletion } from '../../../src/services/ai-proxy-shared';
import { complete } from '../../../src/services/debug-agent-tools';
import { resolveOpenAICompatibleTarget } from '../../../src/services/llm-chat-target';
import { createAdminSettingsEnv } from '../../helpers/admin-settings-env';

let fixture: ReturnType<typeof createAdminSettingsEnv>;
let env: Env;
let calls: string[];
let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fixture = createAdminSettingsEnv({
    AI_GATEWAY_ID: 'gateway',
    CF_ACCOUNT_ID: 'account',
    CF_API_TOKEN: 'cf-secret',
  });
  env = fixture.env;
  calls = [];
  const original = env.DATABASE.prepare.bind(env.DATABASE);
  vi.spyOn(env.DATABASE, 'prepare').mockImplementation((sql) => {
    calls.push(sql);
    return original(sql);
  });
  fetchMock = vi.fn(
    async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: 'Working title' } }] }), {
        headers: { 'Content-Type': 'application/json' },
      })
  );
  vi.stubGlobal('fetch', fetchMock);
  __resetAdminSettingsCacheForTest();
});
afterEach(() => {
  fixture.sqlite.close();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function configure(baseUrl = 'https://llm.example.com/v1') {
  await updateAdminSettings(env, {
    actorUserId: 'admin',
    changes: [
      { name: 'llm.openAICompatible.baseUrl', value: baseUrl },
      { name: 'llm.openAICompatible.model', value: 'operator-model' },
      { name: 'llm.openAICompatible.apiKey', value: 'endpoint-secret' },
    ],
  });
}

describe('L12 endpoint routing through real settings storage/cache', () => {
  it('keeps URL and key from one generation when admin rotates between capability and settings reads', async () => {
    await configure();
    let release!: () => void, entered!: () => void;
    const paused = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const original = capabilities.resolveLlmEndpointCapability;
    const gate = vi
      .spyOn(capabilities, 'resolveLlmEndpointCapability')
      .mockImplementationOnce(async (env) => {
        const old = await original(env);
        entered();
        await paused;
        return old;
      });
    const pending = resolveOpenAICompatibleTarget(env, 'agent', 'model');
    await ready;
    await updateAdminSettings(env, {
      actorUserId: 'admin',
      changes: [
        { name: 'llm.openAICompatible.baseUrl', value: 'https://new-endpoint.example.org/v1' },
        { name: 'llm.openAICompatible.apiKey', value: 'new-endpoint-secret' },
      ],
    });
    release();
    expect(await pending).toMatchObject({
      baseUrl: 'https://new-endpoint.example.org/v1',
      apiKey: 'new-endpoint-secret',
    });
    gate.mockRestore();
  });

  it('routes the real SAM operator AI SDK model through the guarded endpoint fetch', async () => {
    await configure();
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id: 'reply',
          created: 1,
          model: 'operator-model',
          choices: [
            { index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'Hello' } },
          ],
          usage: { prompt_tokens: 2, completion_tokens: 1 },
        }),
        { headers: { 'Content-Type': 'application/json' } }
      )
    );
    const model = await resolveOperatorModel(env, 'claude-original', {
      metadata: 'private-user',
      sessionAffinity: 'private-session',
    });
    if (
      typeof model !== 'object' ||
      model === null ||
      !('doGenerate' in model) ||
      typeof model.doGenerate !== 'function'
    )
      throw new Error('Expected SDK language model');
    await model.doGenerate({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }],
      maxOutputTokens: 16,
    });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://llm.example.com/v1/chat/completions');
    expect(JSON.parse(String(init.body))).toMatchObject({ model: 'operator-model' });
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer endpoint-secret');
    expect(new Headers(init.headers).get('cf-aig-metadata')).toBeNull();
    expect(new Headers(init.headers).get('x-session-affinity')).toBeNull();
    expect(init.redirect).toBe('manual');
  });

  it('unconfigured Cloudflare calls read settings once per isolate TTL, never credentials, across request facades', async () => {
    vi.useFakeTimers();
    const call = async () => {
      const database = createRequestScopedD1(env.DATABASE);
      await fetchWorkersAIChatCompletion(
        { ...env, DATABASE: database },
        {
          modelId: '@cf/test/model',
          maxTokens: 64,
          timeoutMs: 5000,
          messages: [{ role: 'user', content: 'title' }],
          metadata: {},
          responseLabel: 'test',
        }
      );
    };
    await Promise.all(Array.from({ length: 20 }, call));
    for (let i = 0; i < 10; i++) await call();
    expect(fetchMock).toHaveBeenCalledTimes(30);
    expect(calls.filter((sql) => sql.includes('FROM platform_settings'))).toHaveLength(1);
    expect(calls.filter((sql) => sql.includes('platform_credentials'))).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(60_001);
    await call();
    expect(calls.filter((sql) => sql.includes('FROM platform_settings'))).toHaveLength(2);
  });

  it('real admin writer stores raw URL and per-purpose model; endpoint overrides Workers AI without metadata leakage', async () => {
    await configure();
    await updateAdminSettings(env, {
      actorUserId: 'admin',
      changes: [{ name: 'llm.openAICompatible.taskTitleModel', value: 'title-model' }],
    });
    calls.length = 0;
    await fetchWorkersAIChatCompletion(env, {
      purpose: 'taskTitle',
      modelId: '@cf/model',
      maxTokens: 64,
      timeoutMs: 5000,
      reasoningEffort: 'low',
      chatTemplateKwargs: { enable_thinking: false },
      messages: [{ role: 'user', content: 'hello' }],
      metadata: { userId: 'private-user' },
      responseLabel: 'title',
    });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://llm.example.com/v1/chat/completions');
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer endpoint-secret');
    expect(new Headers(init.headers).get('cf-aig-metadata')).toBeNull();
    expect(JSON.parse(String(init.body))).toMatchObject({
      model: 'title-model',
      messages: [{ role: 'user', content: 'hello' }],
    });
    expect(JSON.parse(String(init.body))).not.toHaveProperty('reasoning_effort');
    expect(JSON.parse(String(init.body))).not.toHaveProperty('chat_template_kwargs');
    expect(calls.filter((sql) => sql.includes('platform_credentials'))).toHaveLength(1);
    await resolveOpenAICompatibleTarget(env, 'agent', 'claude-original');
    expect(calls.filter((sql) => sql.includes('platform_credentials'))).toHaveLength(1);
    await updateAdminSettings(env, {
      actorUserId: 'admin',
      changes: [{ name: 'llm.openAICompatible.baseUrl', value: null }],
    });
    expect(await resolveOpenAICompatibleTarget(env, 'agent', 'claude-original')).toBeNull();
  });

  it('configured snapshot failure returns 503 without rerouting, including a cold isolate', async () => {
    await configure();
    expect(await resolveOpenAICompatibleTarget(env, 'agent', 'claude-original')).toMatchObject({
      model: 'operator-model',
    });
    __resetAdminSettingsCacheForTest();
    vi.spyOn(env.DATABASE, 'prepare').mockImplementation(() => {
      throw new Error('database unavailable');
    });
    const result = await forwardToWorkersAI(env, { messages: [] }, '@cf/model', '{}');
    expect(result.status).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a private endpoint until the admin opts in, including redirects', async () => {
    await configure('http://127.0.0.1:1234/v1');
    await expect(
      resolveOpenAICompatibleTarget(env, 'taskTitle', '@cf/model')
    ).rejects.toMatchObject({ reason: 'private_network_not_allowed' });
    expect(fetchMock).not.toHaveBeenCalled();
    await updateAdminSettings(env, {
      actorUserId: 'admin',
      changes: [{ name: 'llm.openAICompatible.allowPrivateNetwork', value: true }],
    });
    expect(await resolveOpenAICompatibleTarget(env, 'agent', 'model')).toMatchObject({
      allowPrivateNetwork: true,
    });
  });

  it('preserves caller include_usage false and never forces it on', async () => {
    await configure();
    await forwardToWorkersAI(
      env,
      { stream: true, stream_options: { include_usage: false } },
      '@cf/model',
      'secret-metadata'
    );
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      stream_options: { include_usage: false },
    });
  });

  it.each(['title', 'diagnosis'])(
    '%s settings lookup uses at most one quarter of inference budget',
    async (purpose) => {
      vi.useFakeTimers();
      const statement = { all: () => new Promise(() => {}) };
      vi.spyOn(env.DATABASE, 'prepare').mockReturnValue(statement as never);
      invalidateAdminSettings(env);
      const options = {
        modelId: '@cf/model',
        maxTokens: 32,
        timeoutMs: 400,
        messages: [{ role: 'user' as const, content: 'hello' }],
        metadata: {},
        responseLabel: 'title',
      };
      const promise =
        purpose === 'title'
          ? fetchWorkersAIChatCompletion(env, options)
          : complete(
              env,
              { model: '@cf/model', timeoutMs: 400 } as never,
              'diagnosis',
              [{ role: 'user', content: 'hello' }],
              32
            );
      const assertion = expect(promise).rejects.toMatchObject({ reason: 'settings_unreadable' });
      await vi.advanceTimersByTimeAsync(101);
      await assertion;
      expect(fetchMock).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(5000);
    }
  );
});

describe('L11 gateway condition vs ambient gateway ID', () => {
  it('complete gateway config is available without settings reads; ID alone is not availability', async () => {
    expect(await isAiProxyEnabled(env)).toBe(true);
    expect(calls).toHaveLength(0);
    const noAccount = { ...env, CF_ACCOUNT_ID: '' };
    expect(await isAiProxyEnabled(noAccount)).toBe(false);
    await updateAdminSettings(env, {
      actorUserId: 'admin',
      changes: [{ name: 'aiProxy.directUpstreamEnabled', value: true }],
    });
    expect(await isAiProxyEnabled(noAccount)).toBe(true);
    expect(await isAiProxyEnabled({ ...noAccount, AI_PROXY_ENABLED: 'false' })).toBe(false);
  });
});
