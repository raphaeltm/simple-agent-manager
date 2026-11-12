/**
 * A3a (overnight B3): task titles on a self-hosted box.
 *
 * The box's Worker vars come from the real celld config generator (`buildCelldConfig`), and the
 * title config from the real `getTaskTitleConfig`, the same call every task-submit path makes. The
 * generator used to force `TASK_TITLE_GENERATION_ENABLED='false'`, so a box never generated a title
 * even with an endpoint configured. Now:
 * - with `llm.openAICompatible.*` set, the title comes from that endpoint;
 * - with nothing set, the title is the truncated prompt, and no request leaves the Worker;
 * - Cloudflare (gateway configured, no endpoint) still calls AI Gateway (control).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import * as TOML from '@iarna/toml';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { WranglerToml } from '../../../../../scripts/deploy/types';
import { buildCelldConfig } from '../../../../../scripts/selfhost/celld-config';

const settings = new Map<string, unknown>();
vi.mock('../../../src/services/admin-settings-resolution', () => ({
  resolveAdminSettingDetailsMany: async (_env: unknown, names: string[]) =>
    names.map((name) => ({ name, value: settings.get(name) ?? null })),
}));

import type { Env } from '../../../src/env';
import { generateTaskTitle, getTaskTitleConfig } from '../../../src/services/task-title';

const LONG_PROMPT =
  'Please investigate why the nightly export job fails on large projects and fix the pagination ' +
  'so that it streams rows instead of loading every project into memory at once, then add tests.';

/** The Worker vars a box runs with: the real wrangler.toml through the real generator. */
function boxVars(): Record<string, string> {
  const source = TOML.parse(
    readFileSync(join(import.meta.dirname, '../../../wrangler.toml'), 'utf8')
  ) as WranglerToml;
  return buildCelldConfig(source, { main: 'src/index.ts', baseDomain: 'sam.example.com' }).config
    .vars;
}

function chatCompletion(content: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

const fetchMock = vi.fn();

beforeEach(() => {
  settings.clear();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('task titles on a self-hosted box', () => {
  it('generates the title through the admin-configured OpenAI-compatible endpoint', async () => {
    const vars = boxVars();
    expect(vars.TASK_TITLE_GENERATION_ENABLED).toBeUndefined();
    settings.set('llm.openAICompatible.baseUrl', 'https://llm.example.com/v1');
    settings.set('llm.openAICompatible.apiKey', 'sk-test-endpoint-key-000000');
    settings.set('llm.openAICompatible.taskTitleModel', 'small-title-model');
    fetchMock.mockResolvedValueOnce(chatCompletion('**Fix nightly export pagination**'));

    const env = { ...vars, DATABASE: {} } as unknown as Env;
    const title = await generateTaskTitle(env, LONG_PROMPT, getTaskTitleConfig(env));

    expect(title).toBe('Fix nightly export pagination');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://llm.example.com/v1/chat/completions');
    expect(JSON.parse(String(init.body)).model).toBe('small-title-model');
    expect(new Headers(init.headers).get('Authorization')).toBe(
      'Bearer sk-test-endpoint-key-000000'
    );
  });

  it('falls back to the truncated prompt when no endpoint is configured', async () => {
    const env = { ...boxVars(), DATABASE: {} } as unknown as Env;
    const config = getTaskTitleConfig(env);
    const title = await generateTaskTitle(env, LONG_PROMPT, config);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(title.endsWith('...')).toBe(true);
    expect(title.length).toBe(config.maxLength);
    expect(LONG_PROMPT.startsWith(title.slice(0, -3))).toBe(true);
  });

  it('still calls AI Gateway on Cloudflare with no endpoint (control)', async () => {
    fetchMock.mockResolvedValueOnce(chatCompletion('Fix nightly export pagination'));
    const env = {
      DATABASE: {},
      CF_ACCOUNT_ID: 'account-1',
      CF_API_TOKEN: 'cf-token',
      AI_GATEWAY_ID: 'gateway-1',
    } as unknown as Env;

    const title = await generateTaskTitle(env, LONG_PROMPT, getTaskTitleConfig(env));

    expect(title).toBe('Fix nightly export pagination');
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url.startsWith('https://gateway.ai.cloudflare.com/v1/account-1/gateway-1/')).toBe(true);
  });
});
