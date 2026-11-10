/**
 * The admin-configured OpenAI-compatible endpoint, through every control-plane caller (self-host
 * T5): no caller lets the runtime follow a redirect, a redirect to the metadata server is never
 * requested, and a private-network endpoint needs `llm.openAICompatible.allowPrivateNetwork`.
 *
 * The endpoint is configured with the real admin settings writer; each caller is its real
 * function. Only `fetch` is stubbed.
 */
import type { SamConfig } from '@simple-agent-manager/shared';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runAgentLoop } from '../../../src/durable-objects/sam-session/agent-loop';
import { resolveOperatorModel } from '../../../src/durable-objects/sam-session/operator/model';
import type { Env } from '../../../src/env';
import { forwardToWorkersAI } from '../../../src/routes/ai-proxy-upstream';
import {
  __resetAdminSettingsCacheForTest,
  updateAdminSettings,
} from '../../../src/services/admin-settings';
import { complete } from '../../../src/services/debug-agent-tools';
import {
  LlmUnavailableError,
  resolveWorkersAiChatTarget,
} from '../../../src/services/llm-chat-target';
import { generateTaskTitle } from '../../../src/services/task-title';
import { createAdminSettingsEnv } from '../../helpers/admin-settings-env';

const METADATA_URL =
  'http://169.254.169.254/computeMetadata/v1/instance/service-accounts/default/token';
const COMPLETION = {
  id: 'chatcmpl-1',
  object: 'chat.completion',
  created: 1,
  model: 'm',
  choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
};
const SAM_CONFIG = {
  model: 'claude-sonnet-5',
  maxTokens: 128,
  maxTurns: 1,
  maxRequestBodyBytes: 100_000,
  maxToolResultBytes: 10_000,
  aigSource: 'sam-session',
  ftsEnabled: false,
} as SamConfig;

let sqlite: Database.Database;
let env: Env;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  __resetAdminSettingsCacheForTest();
  ({ sqlite, env } = createAdminSettingsEnv());
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  sqlite.close();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function configureEndpoint(values: Record<string, string | boolean>) {
  await updateAdminSettings(env, {
    changes: Object.entries(values).map(([key, value]) => ({
      name: `llm.openAICompatible.${key}` as never,
      value,
    })),
    actorUserId: 'admin',
  });
}

function requestedUrls(): string[] {
  return fetchMock.mock.calls.map(([input]) =>
    input instanceof Request ? input.url : String(input)
  );
}

/** Every endpoint request answers a redirect to the metadata server. */
function stubRedirectToMetadata() {
  fetchMock = vi.fn(
    async () => new Response(null, { status: 302, headers: { Location: METADATA_URL } })
  );
  vi.stubGlobal('fetch', fetchMock);
}

function stubCompletion() {
  fetchMock = vi.fn(async () => Response.json(COMPLETION));
  vi.stubGlobal('fetch', fetchMock);
}

const CALLERS: Array<[string, () => Promise<unknown>]> = [
  [
    'task titles (fetchWorkersAIChatCompletion)',
    () =>
      generateTaskTitle(env, 'Refactor the billing job '.repeat(10), {
        model: '@cf/m/x',
        maxRetries: 0,
      }),
  ],
  [
    '/ai/v1 Workers AI route (forwardToWorkersAI)',
    () => forwardToWorkersAI(env, { messages: [{ role: 'user', content: 'hi' }] }, '@cf/m/x', '{}'),
  ],
  [
    'diagnosis runner (complete)',
    () =>
      complete(
        env,
        { model: '@cf/m/x', timeoutMs: 5_000 } as never,
        'debug-test',
        [{ role: 'user', content: 'hi' }] as never,
        64
      ),
  ],
  [
    'SAM agent loop (callOpenAIChatLLM)',
    () =>
      runAgentLoop(
        'conv-1',
        [],
        'hi',
        SAM_CONFIG,
        env,
        'user-1',
        new WritableStream<Uint8Array>().getWriter(),
        vi.fn()
      ),
  ],
  [
    'SAM operator (Mastra model)',
    async () => {
      const model = await resolveOperatorModel(env, '@cf/m/x', {
        metadata: '{}',
        sessionAffinity: 'sam-conv-1',
      });
      return (model as { doGenerate: (options: unknown) => Promise<unknown> }).doGenerate({
        prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      });
    },
  ],
];

describe('every endpoint caller refuses a redirect to the metadata server', () => {
  it.each(CALLERS)('%s', async (_name, call) => {
    await configureEndpoint({ baseUrl: 'https://llm.example.com/v1', model: 'm' });
    stubRedirectToMetadata();

    await call().catch(() => undefined);

    // Liveness: the endpoint was called, so the absence below is the guard's doing.
    expect(requestedUrls()[0]).toBe('https://llm.example.com/v1/chat/completions');
    expect(requestedUrls()).not.toContain(METADATA_URL);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((fetchMock.mock.calls[0]?.[1] as RequestInit | undefined)?.redirect).toBe('manual');
  });
});

describe('a private-network endpoint is an explicit admin opt-in', () => {
  it('is refused with an actionable reason, without any request, when not opted in', async () => {
    await configureEndpoint({ baseUrl: 'http://127.0.0.1:11434/v1', model: 'llama' });
    stubCompletion();

    const outcome = await resolveWorkersAiChatTarget(env, 'diagnosis', '@cf/m/x').catch(
      (err: unknown) => err
    );

    expect(outcome).toBeInstanceOf(LlmUnavailableError);
    expect((outcome as LlmUnavailableError).reason).toBe('private_network_not_allowed');
    expect((outcome as Error).message).toContain('allowPrivateNetwork');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(CALLERS)('control: opted in, %s reaches the local model server', async (_name, call) => {
    await configureEndpoint({
      baseUrl: 'http://127.0.0.1:11434/v1',
      model: 'llama',
      allowPrivateNetwork: true,
    });
    stubCompletion();

    await call().catch(() => undefined);

    expect(requestedUrls()[0]).toBe('http://127.0.0.1:11434/v1/chat/completions');
  });

  it('opted in, a redirect from the local server to the metadata server is still refused', async () => {
    await configureEndpoint({
      baseUrl: 'http://ollama:11434/v1',
      model: 'llama',
      allowPrivateNetwork: true,
    });
    stubRedirectToMetadata();

    await expect(
      complete(env, { model: '@cf/m/x', timeoutMs: 5_000 } as never, 'debug-test', [] as never, 64)
    ).rejects.toThrow();
    expect(requestedUrls()).toEqual(['http://ollama:11434/v1/chat/completions']);
  });

  it('control: a public HTTPS endpoint needs no opt-in', async () => {
    await configureEndpoint({ baseUrl: 'https://llm.example.com/v1', model: 'm' });
    const target = await resolveWorkersAiChatTarget(env, 'diagnosis', '@cf/m/x');
    expect(target).toMatchObject({ kind: 'openai-compatible', allowPrivateNetwork: false });
  });
});
