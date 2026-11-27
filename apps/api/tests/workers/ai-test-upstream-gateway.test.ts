/**
 * Test-only fake AI upstream on an installation WITH an AI Gateway (the staging shape), driven
 * through the real Worker (`worker.fetch` -> AI proxy routes) with real D1 admin settings, KV and
 * the real `AiTokenBudgetCounter`.
 *
 * Only the network edge is faked, and it is faked faithfully: the stubbed `fetch` plays the AI
 * Gateway. A call to the fake's custom provider is handed to the real fake Worker handler
 * (`handleFakeAiUpstreamRequest`) with the gating header the provider config adds, exactly as the
 * gateway forwards it. Any other gateway URL is "the real provider" and answers a recognisable
 * body, so a test can tell which upstream answered.
 */
import {
  AI_TEST_UPSTREAM_COST_HEADER,
  AI_TEST_UPSTREAM_GATE_HEADER,
  AI_TEST_UPSTREAM_GATE_VALUE,
  FAKE_UPSTREAM_TEXT,
} from '@simple-agent-manager/ai-proxy';
import { handleFakeAiUpstreamRequest } from '@simple-agent-manager/ai-proxy/internal/ai-test-upstream-worker';
import { PLATFORM_AI_MODELS } from '@simple-agent-manager/shared';
import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../src/env';
import worker from '../../src/index';
import { updateAdminSettings } from '../../src/services/admin-settings-mutations';
import { invalidateAdminSettings } from '../../src/services/admin-settings-resolution';
import { signCallbackToken } from '../../src/services/jwt';
import { seedNode, seedUser, seedWorkspace } from './helpers/seed-d1';

const bindings = env as unknown as Env;
const PREFIX = `aitestgw-${Date.now()}`;
const ADMIN_ID = `${PREFIX}-admin`;
const GATEWAY_TOKEN = 'test-gateway-token';
const PROVIDER = 'custom-sam-test-upstream';
const REAL_PROVIDER_TEXT = 'real provider answered';

const CLAUDE_MODEL = PLATFORM_AI_MODELS.find(
  (model) => model.provider === 'anthropic' && model.costPer1kOutputTokens >= 0.015
)!;
const OPENAI_MODEL = PLATFORM_AI_MODELS.find(
  (model) => model.provider === 'openai' && model.costPer1kOutputTokens >= 0.008
)!;

/** The staging shape: an AI Gateway, the deploy flag and the fake's custom provider. */
const STAGING_ENV: Partial<Env> = {
  AI_GATEWAY_ID: 'sam',
  CF_ACCOUNT_ID: 'acct',
  CF_AIG_TOKEN: GATEWAY_TOKEN,
  // The account API: without it a gateway install cannot price spend, so no cap applies.
  CF_API_TOKEN: 'test-account-api-token',
  ENVIRONMENT: 'staging',
  AI_TEST_UPSTREAM_ENABLED: 'true',
  AI_TEST_UPSTREAM_GATEWAY_PROVIDER: PROVIDER,
};

interface SeenCall {
  url: string;
  headers: Headers;
}
let seen: SeenCall[];
let fetchSpy: ReturnType<typeof vi.spyOn>;

/** Plays AI Gateway: forwards custom-provider calls to the fake Worker, answers the rest itself. */
async function gateway(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const request = new Request(input, init);
  seen.push({ url: request.url, headers: new Headers(request.headers) });
  const url = new URL(request.url);
  if (url.host !== 'gateway.ai.cloudflare.com') {
    throw new Error(`unexpected outbound fetch: ${request.url}`);
  }
  const [, , account, gatewayId, provider, ...rest] = url.pathname.split('/');
  expect(account).toBe('acct');
  expect(gatewayId).toBe('sam');
  if (provider === PROVIDER) {
    // The gateway consumes its own cf-aig-* headers and adds the provider config's headers.
    const forwarded = new Headers();
    request.headers.forEach((value, name) => {
      if (!name.startsWith('cf-aig-')) forwarded.set(name, value);
    });
    forwarded.set(AI_TEST_UPSTREAM_GATE_HEADER, AI_TEST_UPSTREAM_GATE_VALUE);
    return handleFakeAiUpstreamRequest(
      new Request(`https://sam-fake-ai-staging.example.workers.dev/${rest.join('/')}`, {
        method: request.method,
        headers: forwarded,
        body: await request.text(),
      })
    );
  }
  return new Response(
    JSON.stringify({
      id: 'msg_real',
      type: 'message',
      role: 'assistant',
      model: CLAUDE_MODEL.id,
      content: [{ type: 'text', text: REAL_PROVIDER_TEXT }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  );
}

beforeEach(() => {
  seen = [];
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(gateway);
});

afterEach(() => {
  fetchSpy.mockRestore();
});

async function setSettings(
  changes: Parameters<typeof updateAdminSettings>[1]['changes']
): Promise<void> {
  await seedUser(ADMIN_ID);
  await updateAdminSettings({ ...bindings, ...STAGING_ENV }, { actorUserId: ADMIN_ID, changes });
  invalidateAdminSettings(bindings);
}

async function seedCaller(suffix: string): Promise<{ userId: string; token: string }> {
  const userId = `${PREFIX}-${suffix}`;
  const workspaceId = `${PREFIX}-ws-${suffix}`;
  await seedUser(userId);
  const nodeId = `${PREFIX}-node-${suffix}`;
  await seedNode(nodeId, userId);
  await seedWorkspace(workspaceId, nodeId, userId, { status: 'running' });
  return {
    userId,
    token: await signCallbackToken(workspaceId, bindings, { callbackGeneration: null }),
  };
}

async function call(
  path: string,
  token: string,
  body: Record<string, unknown>,
  overrides: Partial<Env> = STAGING_ENV
): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(
    new Request(`https://api.${bindings.BASE_DOMAIN}${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    }),
    { ...bindings, ...overrides },
    ctx
  );
  const text = await response.text();
  await waitOnExecutionContext(ctx);
  return new Response(text, { status: response.status, headers: response.headers });
}

const nativeMessages = (stream: boolean) => ({
  model: CLAUDE_MODEL.id,
  max_tokens: 64,
  stream,
  messages: [{ role: 'user', content: 'hello' }],
});

function gatewayProviders(): string[] {
  return seen.map((entry) => new URL(entry.url).pathname.split('/')[4] ?? '');
}

describe('fake AI upstream through the AI Gateway (staging shape)', () => {
  it('routes an allowlisted call to the custom provider, with no provider key', async () => {
    const caller = await seedCaller('routed');
    await setSettings([
      { name: 'aiProxy.directUpstreamEnabled', value: true },
      { name: 'aiProxy.perUserMonthlyCostCeilingUsd', value: 0 },
      { name: 'aiProxy.testUpstreamUserIds', value: [caller.userId] },
      { name: 'aiProxy.testUpstreamCostPerCallCents', value: 40 },
    ]);

    const response = await call('/ai/anthropic/v1/messages', caller.token, nativeMessages(false));
    expect(response.status).toBe(200);
    expect(await response.text()).toContain(FAKE_UPSTREAM_TEXT);

    expect(seen).toHaveLength(1);
    const [only] = seen;
    expect(new URL(only!.url).pathname).toBe(`/v1/acct/sam/${PROVIDER}/v1/messages`);
    // Gateway auth and attribution go to the gateway; no provider credential goes anywhere.
    expect(only!.headers.get('cf-aig-authorization')).toBe(`Bearer ${GATEWAY_TOKEN}`);
    expect(JSON.parse(only!.headers.get('cf-aig-metadata') ?? '{}')).toMatchObject({
      userId: caller.userId,
    });
    expect(only!.headers.get('x-api-key')).toBeNull();
    expect(only!.headers.get('authorization')).toBeNull();
    expect(only!.headers.get(AI_TEST_UPSTREAM_COST_HEADER)).toBe('0.4');
    expect(JSON.parse(only!.headers.get('cf-aig-custom-cost') ?? '{}')).toEqual({
      per_token_in: CLAUDE_MODEL.costPer1kInputTokens / 1000,
      per_token_out: CLAUDE_MODEL.costPer1kOutputTokens / 1000,
    });
  });

  it('refuses the 4th $0.40 call against a $1 ceiling, on every faked route', async () => {
    const caller = await seedCaller('ceiling');
    await setSettings([
      { name: 'aiProxy.directUpstreamEnabled', value: true },
      { name: 'aiProxy.perUserMonthlyCostCeilingUsd', value: 1 },
      { name: 'aiProxy.testUpstreamUserIds', value: [caller.userId] },
      { name: 'aiProxy.testUpstreamCostPerCallCents', value: 40 },
    ]);

    const first = await call('/ai/anthropic/v1/messages', caller.token, nativeMessages(true));
    expect(first.status).toBe(200);
    expect(await first.text()).toContain(FAKE_UPSTREAM_TEXT);
    const second = await call('/ai/v1/chat/completions', caller.token, {
      model: OPENAI_MODEL.id,
      stream: true,
      messages: [{ role: 'user', content: 'hello' }],
    });
    expect(second.status).toBe(200);
    expect(await second.text()).toContain(FAKE_UPSTREAM_TEXT);
    const third = await call('/ai/v1/responses', caller.token, {
      model: OPENAI_MODEL.id,
      input: 'hello',
    });
    expect(third.status).toBe(200);
    expect(await third.text()).toContain(FAKE_UPSTREAM_TEXT);

    const fourth = await call('/ai/anthropic/v1/messages', caller.token, nativeMessages(false));
    expect(fourth.status).toBe(429);
    expect(await fourth.text()).toContain('Administrator monthly AI spending limit reached');

    // Every call that left the Worker went to the fake's provider, none to a real one.
    expect(gatewayProviders()).toEqual([PROVIDER, PROVIDER, PROVIDER]);
  });

  it('keeps a user who is not allowlisted on the real upstream', async () => {
    const listed = await seedCaller('listed');
    const other = await seedCaller('other');
    await setSettings([
      { name: 'aiProxy.directUpstreamEnabled', value: true },
      { name: 'aiProxy.perUserMonthlyCostCeilingUsd', value: 0 },
      { name: 'aiProxy.testUpstreamUserIds', value: [listed.userId] },
    ]);

    const fake = await call('/ai/anthropic/v1/messages', listed.token, nativeMessages(false));
    expect(fake.status).toBe(200);
    expect(await fake.text()).toContain(FAKE_UPSTREAM_TEXT);

    const real = await call('/ai/anthropic/v1/messages', other.token, nativeMessages(false));
    expect(real.status).toBe(200);
    expect(await real.text()).toContain(REAL_PROVIDER_TEXT);
    expect(gatewayProviders()).toEqual([PROVIDER, 'anthropic']);
  });

  it.each([
    ['a production deployment', { ...STAGING_ENV, ENVIRONMENT: 'production' }],
    ['a fork production stack with an unmapped name', { ...STAGING_ENV, ENVIRONMENT: 'prod' }],
    ['no deploy flag', { ...STAGING_ENV, AI_TEST_UPSTREAM_ENABLED: undefined }],
    [
      'no fake provider configured',
      { ...STAGING_ENV, AI_TEST_UPSTREAM_GATEWAY_PROVIDER: undefined },
    ],
    [
      'a provider var naming a real provider',
      { ...STAGING_ENV, AI_TEST_UPSTREAM_GATEWAY_PROVIDER: 'anthropic' },
    ],
  ])('never routes to the fake on %s, even for an allowlisted user', async (_label, envShape) => {
    const caller = await seedCaller(`locked-${crypto.randomUUID().slice(0, 8)}`);
    await setSettings([
      { name: 'aiProxy.directUpstreamEnabled', value: true },
      { name: 'aiProxy.perUserMonthlyCostCeilingUsd', value: 0 },
      { name: 'aiProxy.testUpstreamUserIds', value: [caller.userId] },
    ]);

    // Control: the staging shape routes this exact caller to the fake.
    const control = await call('/ai/anthropic/v1/messages', caller.token, nativeMessages(false));
    expect(await control.text()).toContain(FAKE_UPSTREAM_TEXT);

    const locked = await call(
      '/ai/anthropic/v1/messages',
      caller.token,
      nativeMessages(false),
      envShape
    );
    expect(locked.status).toBe(200);
    expect(await locked.text()).toContain(REAL_PROVIDER_TEXT);
    expect(gatewayProviders()).toEqual([PROVIDER, 'anthropic']);
  });
});
