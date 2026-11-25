/**
 * Test-only fake AI upstream (`services/ai-test-upstream.ts`), driven through the real Worker
 * (`worker.fetch` -> index.ts -> the AI proxy routes) with real D1 admin settings, real KV and
 * the real `AiTokenBudgetCounter` Durable Object, on an installation without AI Gateway (the
 * self-host box shape).
 *
 * The scenario the harness exists for: an administrator ceiling of $1, fake calls costing $0.40
 * at list price, calls 1-3 succeed and are metered, call 4 is refused by the ceiling, and the
 * spend shows in the user's usage API (Settings > Usage). Nothing may leave the Worker.
 *
 * The locks are tested in the same environment: a user who is not allowlisted, a production
 * deployment, a missing deploy flag and an installation with an AI Gateway all take the real
 * upstream path, which needs a platform key this installation does not have (503), where the
 * fake would have answered 200.
 */
import { PLATFORM_AI_MODELS } from '@simple-agent-manager/shared';
import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../src/env';
import worker from '../../src/index';
import { updateAdminSettings } from '../../src/services/admin-settings-mutations';
import { invalidateAdminSettings } from '../../src/services/admin-settings-resolution';
import { FAKE_UPSTREAM_TEXT } from '../../src/services/ai-test-upstream-responses';
import { signCallbackToken } from '../../src/services/jwt';
import { seedNode, seedSignedInUser, seedUser, seedWorkspace } from './helpers/seed-d1';

const bindings = env as unknown as Env;
const PREFIX = `aitestup-${Date.now()}`;
const ADMIN_ID = `${PREFIX}-admin`;

/** A catalog Anthropic model whose output price keeps four $0.40 calls under the daily budget. */
const CLAUDE_MODEL = PLATFORM_AI_MODELS.find(
  (model) => model.provider === 'anthropic' && model.costPer1kOutputTokens >= 0.015
)!;
const OPENAI_MODEL = PLATFORM_AI_MODELS.find(
  (model) => model.provider === 'openai' && model.costPer1kOutputTokens >= 0.008
)!;

/** The self-host box shape: no AI Gateway, a non-production label, the deploy flag set. */
const BOX_ENV: Partial<Env> = {
  AI_GATEWAY_ID: '',
  ENVIRONMENT: 'selfhost',
  AI_TEST_UPSTREAM_ENABLED: 'true',
};

let fetchSpy: ReturnType<typeof vi.spyOn>;

beforeAll(() => {
  expect(CLAUDE_MODEL).toBeDefined();
  expect(OPENAI_MODEL).toBeDefined();
});

beforeEach(() => {
  // Nothing in these tests may reach the network: the fake answers in-process, and the real
  // path fails on the missing platform key before it fetches.
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    throw new Error(
      `unexpected outbound fetch: ${String(input instanceof Request ? input.url : input)}`
    );
  });
});

afterEach(() => {
  fetchSpy.mockRestore();
});

async function setSettings(
  changes: Parameters<typeof updateAdminSettings>[1]['changes'],
  overrides: Partial<Env> = BOX_ENV
): Promise<void> {
  await seedUser(ADMIN_ID);
  await updateAdminSettings({ ...bindings, ...overrides }, { actorUserId: ADMIN_ID, changes });
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
  overrides: Partial<Env> = BOX_ENV
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
  // Read the body before draining waitUntil: accounting runs on the streamed body.
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
const chatCompletion = (model: string, stream: boolean) => ({
  model,
  stream,
  messages: [{ role: 'user', content: 'hello' }],
});

async function usageBudget(userId: string): Promise<Record<string, unknown>> {
  const cookie = await seedSignedInUser(userId);
  const ctx = createExecutionContext();
  const response = await worker.fetch(
    new Request(`https://api.${bindings.BASE_DOMAIN}/api/usage/ai/budget`, {
      headers: { Cookie: cookie },
    }),
    { ...bindings, ...BOX_ENV },
    ctx
  );
  await waitOnExecutionContext(ctx);
  expect(response.status).toBe(200);
  return (await response.json()) as Record<string, unknown>;
}

describe('fake AI upstream: metering and the administrator ceiling on a no-gateway install', () => {
  it('meters each faked call and refuses the 4th $0.40 call against a $1 ceiling', async () => {
    const caller = await seedCaller('ceiling');
    await setSettings([
      { name: 'aiProxy.directUpstreamEnabled', value: true },
      { name: 'aiProxy.perUserMonthlyCostCeilingUsd', value: 1 },
      { name: 'aiProxy.testUpstreamUserIds', value: [caller.userId] },
      { name: 'aiProxy.testUpstreamCostPerCallCents', value: 40 },
    ]);

    // Each proxy route the "sam" provider mode uses, JSON and SSE.
    const first = await call('/ai/anthropic/v1/messages', caller.token, nativeMessages(true));
    expect(first.status).toBe(200);
    expect(await first.text()).toContain(FAKE_UPSTREAM_TEXT);

    const second = await call(
      '/ai/v1/chat/completions',
      caller.token,
      chatCompletion(CLAUDE_MODEL.id, false)
    );
    expect(second.status).toBe(200);
    expect(await second.text()).toContain(FAKE_UPSTREAM_TEXT);

    const third = await call(
      '/ai/v1/chat/completions',
      caller.token,
      chatCompletion(OPENAI_MODEL.id, true)
    );
    expect(third.status).toBe(200);
    expect(await third.text()).toContain(FAKE_UPSTREAM_TEXT);

    // $1.20 spent: the ceiling refuses before any upstream (fake or real) is called.
    const fourth = await call('/ai/v1/responses', caller.token, {
      model: OPENAI_MODEL.id,
      input: 'hello',
    });
    expect(fourth.status).toBe(429);
    const refusal = (await fourth.json()) as {
      error: { type: string; message: string; monthlyCost?: { used: number; cap: number } };
    };
    expect(refusal.error.type).toBe('rate_limit_error');
    expect(refusal.error.message).toContain('Administrator monthly AI spending limit reached');
    expect(refusal.error.monthlyCost?.cap).toBe(1);
    expect(refusal.error.monthlyCost?.used).toBeCloseTo(1.2, 3);

    // The refusal is the same on the native Anthropic route.
    const nativeRefusal = await call(
      '/ai/anthropic/v1/messages',
      caller.token,
      nativeMessages(false)
    );
    expect(nativeRefusal.status).toBe(429);

    // The spend is what Settings > Usage reads.
    const budget = (await usageBudget(caller.userId)) as {
      monthCostUsd: number;
      monthlyCostCap: { ceilingUsd: number | null; effectiveCapUsd: number | null };
      exceeded: boolean;
    };
    expect(budget.monthCostUsd).toBeCloseTo(1.2, 3);
    expect(budget.monthlyCostCap).toMatchObject({ ceilingUsd: 1, effectiveCapUsd: 1 });
    expect(budget.exceeded).toBe(true);

    // Nothing left the Worker: no provider was called and no key was sent.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('keeps every user who is not allowlisted on the real upstream', async () => {
    const listed = await seedCaller('listed');
    const other = await seedCaller('other');
    await setSettings([
      { name: 'aiProxy.directUpstreamEnabled', value: true },
      { name: 'aiProxy.perUserMonthlyCostCeilingUsd', value: 0 },
      { name: 'aiProxy.testUpstreamUserIds', value: [listed.userId] },
    ]);

    // Liveness: the listed user is answered by the fake in the same environment.
    const fake = await call('/ai/anthropic/v1/messages', listed.token, nativeMessages(false));
    expect(fake.status).toBe(200);

    // The other user takes the real path, which needs a platform key this install lacks.
    const real = await call('/ai/anthropic/v1/messages', other.token, nativeMessages(false));
    expect(real.status).toBe(503);
    expect(await real.text()).toContain('AI proxy is not configured');
  });

  it.each([
    ['a production deployment', { ...BOX_ENV, ENVIRONMENT: 'production' }],
    ['a deployment with no environment label', { ...BOX_ENV, ENVIRONMENT: '' }],
    ['a deployment without the deploy flag', { ...BOX_ENV, AI_TEST_UPSTREAM_ENABLED: undefined }],
    ['a deploy flag other than "true"', { ...BOX_ENV, AI_TEST_UPSTREAM_ENABLED: '1' }],
  ])(
    'never answers with the fake on %s, even for an allowlisted user',
    async (_label, envShape) => {
      const caller = await seedCaller(`locked-${crypto.randomUUID().slice(0, 8)}`);
      await setSettings([
        { name: 'aiProxy.directUpstreamEnabled', value: true },
        { name: 'aiProxy.perUserMonthlyCostCeilingUsd', value: 0 },
        { name: 'aiProxy.testUpstreamUserIds', value: [caller.userId] },
      ]);

      // Control: the box shape answers this exact caller with the fake.
      const control = await call(
        '/ai/v1/chat/completions',
        caller.token,
        chatCompletion(CLAUDE_MODEL.id, false)
      );
      expect(control.status).toBe(200);

      const locked = await call(
        '/ai/v1/chat/completions',
        caller.token,
        chatCompletion(CLAUDE_MODEL.id, false),
        envShape
      );
      expect(locked.status).toBe(503);
      expect(await locked.text()).not.toContain(FAKE_UPSTREAM_TEXT);
    }
  );

  it('does not answer in-process where an AI Gateway exists (its logs are the spend record)', async () => {
    const caller = await seedCaller('gateway');
    await setSettings([{ name: 'aiProxy.testUpstreamUserIds', value: [caller.userId] }]);

    const response = await call('/ai/anthropic/v1/messages', caller.token, nativeMessages(false), {
      ...BOX_ENV,
      AI_GATEWAY_ID: 'sam',
      CF_ACCOUNT_ID: 'acct',
    });
    // The real gateway path ran (and was refused or failed here): never the fake's 200.
    expect(response.status).not.toBe(200);
    expect(await response.text()).not.toContain(FAKE_UPSTREAM_TEXT);
  });
});
