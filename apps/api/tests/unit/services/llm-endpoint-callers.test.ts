/**
 * The remaining control-plane LLM callers, each through its real function, against an
 * OpenAI-compatible endpoint configured with the real admin settings writer, plus the
 * "nothing can serve this" case off Cloudflare. Task titles and the agent loop are covered in
 * llm-chat-target.test.ts.
 */
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resolveOperatorModel } from '../../../src/durable-objects/sam-session/operator/model';
import type { Env } from '../../../src/env';
import { forwardToWorkersAI } from '../../../src/routes/ai-proxy-upstream';
import {
  __resetAdminSettingsCacheForTest,
  updateAdminSettings,
} from '../../../src/services/admin-settings';
import { complete } from '../../../src/services/debug-agent-tools';
import { LlmUnavailableError } from '../../../src/services/llm-chat-target';
import { createAdminSettingsEnv } from '../../helpers/admin-settings-env';

const CLOUDFLARE = { CF_ACCOUNT_ID: 'account-1', CF_API_TOKEN: 'cf-token', AI_GATEWAY_ID: 'sam' };
const COMPLETION = {
  id: 'chatcmpl-1',
  object: 'chat.completion',
  created: 1,
  model: 'm',
  choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
};

let sqlite: Database.Database;
let env: Env;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  __resetAdminSettingsCacheForTest();
  ({ sqlite, env } = createAdminSettingsEnv());
  fetchMock = vi.fn(async () => Response.json(COMPLETION));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  sqlite.close();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function configureEndpoint(values: Record<string, string>) {
  await updateAdminSettings(env, {
    changes: Object.entries(values).map(([key, value]) => ({
      name: `llm.openAICompatible.${key}` as never,
      value,
    })),
    actorUserId: 'admin',
  });
}

function lastRequest(): { url: string; headers: Headers; body: Record<string, unknown> } {
  const [input, init] = fetchMock.mock.calls.at(-1) as [RequestInfo | URL, RequestInit];
  const request = input instanceof Request ? input : null;
  const headers = new Headers(init?.headers ?? request?.headers);
  const rawBody = init?.body ?? null;
  return {
    url: request ? request.url : String(input),
    headers,
    body: typeof rawBody === 'string' ? (JSON.parse(rawBody) as Record<string, unknown>) : {},
  };
}

const ENDPOINT = {
  baseUrl: 'https://llm.example.com/v1',
  apiKey: 'sk-endpoint-key',
  model: 'default-model',
};

describe('/ai/v1 Workers AI route (forwardToWorkersAI)', () => {
  it('serves @cf requests from the endpoint with its proxy model, key and no gateway metadata', async () => {
    Object.assign(env, CLOUDFLARE);
    await configureEndpoint({ ...ENDPOINT, aiProxyModel: 'proxy-model' });

    const res = await forwardToWorkersAI(
      env,
      { messages: [{ role: 'user', content: 'hi' }] },
      '@cf/qwen/qwen3-30b-a3b-fp8',
      '{"userId":"u1"}'
    );

    expect(res.status).toBe(200);
    const sent = lastRequest();
    expect(sent.url).toBe('https://llm.example.com/v1/chat/completions');
    expect(sent.headers.get('authorization')).toBe('Bearer sk-endpoint-key');
    expect(sent.headers.get('cf-aig-metadata')).toBeNull();
    expect(sent.body.model).toBe('proxy-model');
  });

  it('keeps the Cloudflare gateway request when no endpoint is configured', async () => {
    Object.assign(env, CLOUDFLARE);
    await forwardToWorkersAI(env, { messages: [] }, '@cf/m/x', '{"userId":"u1"}');
    const sent = lastRequest();
    expect(sent.url).toBe(
      'https://gateway.ai.cloudflare.com/v1/account-1/sam/workers-ai/v1/chat/completions'
    );
    expect(sent.headers.get('cf-aig-metadata')).toBe('{"userId":"u1"}');
    expect(sent.body.model).toBe('@cf/m/x');
  });

  it('answers 404 FEATURE_UNAVAILABLE without any upstream call when nothing can serve it', async () => {
    Object.assign(env, { AI_GATEWAY_ID: 'sam' });
    const res = await forwardToWorkersAI(env, { messages: [] }, '@cf/m/x', '{}');
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: { code: 'FEATURE_UNAVAILABLE' } });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('/ai/v1 Workers AI route when the endpoint settings are unreadable', () => {
  it('answers 503 without calling the endpoint or the Cloudflare gateway', async () => {
    Object.assign(env, CLOUDFLARE);
    await configureEndpoint(ENDPOINT);
    // Liveness: the endpoint serves the route while settings are readable.
    expect((await forwardToWorkersAI(env, { messages: [] }, '@cf/m/x', '{}')).status).toBe(200);
    fetchMock.mockClear();
    __resetAdminSettingsCacheForTest();
    vi.spyOn(env.DATABASE, 'prepare').mockImplementation(() => {
      throw new Error('D1 unavailable');
    });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const res = await forwardToWorkersAI(env, { messages: [] }, '@cf/m/x', '{}');

    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: { code: 'LLM_SETTINGS_UNAVAILABLE' } });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('diagnosis runner (complete)', () => {
  const config = { model: '@cf/zai-org/glm-5.3-flash', timeoutMs: 5_000 } as never;

  it('calls the endpoint with the diagnosis model', async () => {
    Object.assign(env, CLOUDFLARE);
    await configureEndpoint({ ...ENDPOINT, diagnosisModel: 'diagnosis-model' });

    await complete(env, config, 'debug-test', [{ role: 'user', content: 'hi' }] as never, 64);

    const sent = lastRequest();
    expect(sent.url).toBe('https://llm.example.com/v1/chat/completions');
    expect(sent.headers.get('authorization')).toBe('Bearer sk-endpoint-key');
    expect(sent.headers.get('cf-aig-metadata')).toBeNull();
    expect(sent.body.model).toBe('diagnosis-model');
  });

  it('reports that no model is available off Cloudflare, without calling anything', async () => {
    Object.assign(env, { AI_GATEWAY_ID: 'sam' });
    await expect(
      complete(env, config, 'debug-test', [{ role: 'user', content: 'hi' }] as never, 64)
    ).rejects.toThrow(LlmUnavailableError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('SAM operator model (resolveOperatorModel)', () => {
  const headers = { metadata: '{"userId":"u1"}', sessionAffinity: 'sam-conv-1' };

  it('routes the operator to the endpoint with the agent model and no Cloudflare headers', async () => {
    Object.assign(env, CLOUDFLARE);
    await configureEndpoint({ ...ENDPOINT, agentModel: 'agent-model' });

    const model = await resolveOperatorModel(env, '@cf/zai-org/glm-5.3-flash', headers);
    await model.doGenerate({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    } as never);

    const sent = lastRequest();
    expect(sent.url).toBe('https://llm.example.com/v1/chat/completions');
    expect(sent.headers.get('authorization')).toBe('Bearer sk-endpoint-key');
    expect(sent.headers.get('cf-aig-metadata')).toBeNull();
    expect(sent.headers.get('x-session-affinity')).toBeNull();
    expect(sent.body.model).toBe('agent-model');
  });

  it('keeps the Workers AI gateway route and its headers when no endpoint is configured', async () => {
    Object.assign(env, CLOUDFLARE);

    const model = await resolveOperatorModel(env, '@cf/zai-org/glm-5.3-flash', headers);
    await model.doGenerate({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    } as never);

    const sent = lastRequest();
    expect(sent.url).toBe(
      'https://gateway.ai.cloudflare.com/v1/account-1/sam/workers-ai/v1/chat/completions'
    );
    expect(sent.headers.get('cf-aig-metadata')).toBe('{"userId":"u1"}');
    expect(sent.headers.get('x-session-affinity')).toBe('sam-conv-1');
  });

  it('throws LlmUnavailableError off Cloudflare with no endpoint', async () => {
    Object.assign(env, { AI_GATEWAY_ID: 'sam' });
    await expect(
      resolveOperatorModel(env, '@cf/zai-org/glm-5.3-flash', headers)
    ).rejects.toThrow(LlmUnavailableError);
  });
});
