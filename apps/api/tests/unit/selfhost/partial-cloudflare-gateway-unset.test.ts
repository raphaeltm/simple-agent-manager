/**
 * A partially configured Cloudflare deployment: a Cloudflare account and API token are present,
 * but AI Gateway is not (AI_GATEWAY_ID unset or blank). Self-hosters on Cloudflare can reach this
 * by clearing the gateway var. The self-host suite mostly covers the opposite shape (the default
 * gateway id with no account); this file pins the behaviour of this one (apps/api rule 69), each
 * case beside the fully configured Cloudflare control:
 *
 * - Unified Billing is unavailable: no Cloudflare token is ever sent to a provider directly
 *   (before, `cf-aig-authorization` went to api.openai.com / api.anthropic.com and failed).
 * - OpenAI and Anthropic calls go straight to the provider with the platform key and without
 *   `cf-aig-metadata` (SAM's user and workspace ids are for the gateway only).
 * - Workers AI calls use the account's REST API, exactly as before the capability work.
 * - The admin cannot switch billing to "unified" (400).
 * - The monthly cost cron skips with a reason, and the monthly cap is unavailable
 *   (monthly-cost-cap-without-gateway.test.ts).
 */
import type { Context } from 'hono';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/middleware/auth', () => ({
  requireAuth: () => (_c: unknown, next: () => Promise<void>) => next(),
  requireApproved: () => (_c: unknown, next: () => Promise<void>) => next(),
  requireSuperadmin: () => (_c: unknown, next: () => Promise<void>) => next(),
}));
vi.mock('../../../src/services/platform-credentials', () => ({
  getPlatformAgentCredential: vi.fn(async () => ({
    credential: 'sk-platform-key',
    credentialKind: 'api-key',
    credentialId: 'platform-1',
  })),
}));
vi.mock('../../../src/lib/secrets', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/lib/secrets')>()),
  getCredentialEncryptionKey: vi.fn(() => 'mock-encryption-key'),
}));

import type { Env } from '../../../src/env';
import { handleAppError } from '../../../src/middleware/app-error-handler';
import { adminAIProxyRoutes } from '../../../src/routes/admin-ai-proxy';
import {
  forwardToAnthropic,
  forwardToOpenAI,
  forwardToWorkersAI,
} from '../../../src/routes/ai-proxy-upstream';
import { resolveUnifiedBillingToken, resolveUpstreamAuth } from '../../../src/services/ai-billing';
import { runMonthlyCostAggregation } from '../../../src/services/ai-monthly-cost-cron';
import { resolvePlatformCapabilities } from '../../../src/services/platform-capabilities';
import { createMemoryKv } from '../../helpers/sqlite-d1';

const ACCOUNT = { CF_ACCOUNT_ID: 'account-1', CF_API_TOKEN: 'cf-api-token' };
const AIG_METADATA = '{"userId":"user-1","workspaceId":"ws-1"}';
const CHAT = { messages: [{ role: 'user', content: 'hi' }], max_tokens: 16 };

type Shape = 'cloudflare' | 'gateway unset' | 'gateway blank';
function makeEnv(shape: Shape, extra: Partial<Env> = {}): Env {
  const gateway = shape === 'cloudflare' ? 'sam' : shape === 'gateway blank' ? '  ' : undefined;
  return {
    KV: createMemoryKv(),
    DATABASE: {} as D1Database,
    ...ACCOUNT,
    ...(gateway === undefined ? {} : { AI_GATEWAY_ID: gateway }),
    ...extra,
  } as Env;
}
const PARTIAL: Shape[] = ['gateway unset', 'gateway blank'];

let fetchMock: ReturnType<typeof vi.fn>;

function sent(): { url: string; headers: Record<string, string> } {
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
  return { url: String(url), headers: init.headers as Record<string, string> };
}

beforeEach(() => {
  fetchMock = vi.fn(async () => Response.json({ id: 'resp-1', choices: [] }));
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** PATCH the billing mode through the real admin route. */
function billingPatcher(env: Env) {
  const app = new Hono<{ Bindings: Env }>();
  app.onError((err, c: Context) => handleAppError(err as Error, c));
  app.route('/api/admin/ai-proxy', adminAIProxyRoutes);
  return (billingMode: string) =>
    app.request(
      '/api/admin/ai-proxy/config',
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ billingMode }),
      },
      env
    );
}

const ANTHROPIC_OK = {
  id: 'msg_1',
  type: 'message',
  role: 'assistant',
  content: [{ type: 'text', text: 'hello' }],
  model: 'claude-sonnet-5',
  stop_reason: 'end_turn',
  usage: { input_tokens: 3, output_tokens: 2 },
};

describe('capabilities', () => {
  it('cloudflare: AI Gateway and the monthly cap are available', () => {
    expect(resolvePlatformCapabilities(makeEnv('cloudflare'))).toMatchObject({
      aiGateway: true,
      monthlyCostCap: true,
      cloudflareAccountApi: true,
    });
  });

  it.each(PARTIAL)(
    '%s: no gateway, SAM meters the monthly cap itself; the account API stays',
    (shape) => {
      expect(resolvePlatformCapabilities(makeEnv(shape))).toMatchObject({
        aiGateway: false,
        // No gateway logs to read, so SAM prices calls itself (hasLocalAiCostMetering).
        monthlyCostCap: true,
        cloudflareAccountApi: true,
        analyticsQuery: true,
        workersObservability: true,
      });
    }
  );
});

describe('billing mode and upstream auth', () => {
  it('cloudflare: auto mode bills through the gateway with the Cloudflare token', async () => {
    const env = makeEnv('cloudflare');
    expect(resolveUnifiedBillingToken(env)).toBe('cf-api-token');
    const auth = await resolveUpstreamAuth(env, {} as Parameters<typeof resolveUpstreamAuth>[1]);
    expect(auth.headers['cf-aig-authorization']).toBe('Bearer cf-api-token');
  });

  it.each(PARTIAL)(
    '%s: auto mode uses the platform key and never the Cloudflare token',
    async (shape) => {
      const env = makeEnv(shape, { CF_AIG_TOKEN: 'cf-aig-token' } as Partial<Env>);
      expect(resolveUnifiedBillingToken(env)).toBeUndefined();
      const auth = await resolveUpstreamAuth(env, {} as Parameters<typeof resolveUpstreamAuth>[1]);
      expect(auth.headers['x-api-key']).toBe('sk-platform-key');
      expect(auth.headers['cf-aig-authorization']).toBeUndefined();
      expect(JSON.stringify(auth.headers)).not.toMatch(/cf-api-token|cf-aig-token/);
    }
  );

  it.each(PARTIAL)('%s: unified mode refuses with a reason naming the gateway', async (shape) => {
    const env = makeEnv(shape, { AI_PROXY_BILLING_MODE: 'unified' } as Partial<Env>);
    await expect(
      resolveUpstreamAuth(env, {} as Parameters<typeof resolveUpstreamAuth>[1])
    ).rejects.toThrow('needs AI Gateway');
  });

  it.each(PARTIAL)('%s: the admin cannot switch billing to unified (400)', async (shape) => {
    const patch = billingPatcher(makeEnv(shape, { CF_AIG_TOKEN: 'cf-aig-token' } as Partial<Env>));
    const refused = await patch('unified');
    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({ message: expect.stringContaining('AI Gateway') });
    // Liveness: the other modes still save.
    expect((await patch('platform-key')).status).toBe(200);
  });

  it('cloudflare: the admin can switch billing to unified (control)', async () => {
    const patch = billingPatcher(
      makeEnv('cloudflare', { CF_AIG_TOKEN: 'cf-aig-token' } as Partial<Env>)
    );
    expect((await patch('unified')).status).toBe(200);
  });
});

describe('provider forwarding', () => {
  it('cloudflare: OpenAI goes through the gateway with attribution', async () => {
    await forwardToOpenAI(makeEnv('cloudflare'), CHAT, 'gpt-4o', AIG_METADATA, 'sk-openai');
    const { url, headers } = sent();
    expect(url).toBe(
      'https://gateway.ai.cloudflare.com/v1/account-1/sam/openai/v1/chat/completions'
    );
    expect(headers['cf-aig-metadata']).toBe(AIG_METADATA);
  });

  it.each(PARTIAL)(
    '%s: OpenAI goes straight to OpenAI with the key and no SAM ids',
    async (shape) => {
      await forwardToOpenAI(makeEnv(shape), CHAT, 'gpt-4o', AIG_METADATA, 'sk-openai');
      const { url, headers } = sent();
      expect(url).toBe('https://api.openai.com/v1/chat/completions');
      expect(headers.Authorization).toBe('Bearer sk-openai');
      expect(headers['cf-aig-authorization']).toBeUndefined();
      expect(headers['cf-aig-metadata']).toBeUndefined();
    }
  );

  it('cloudflare: Anthropic goes through the gateway with attribution (control)', async () => {
    fetchMock.mockResolvedValueOnce(Response.json(ANTHROPIC_OK));
    await forwardToAnthropic(makeEnv('cloudflare'), CHAT, 'claude-sonnet-5', AIG_METADATA, {
      headers: { 'x-api-key': 'sk-platform-key' },
    } as Parameters<typeof forwardToAnthropic>[4]);
    const { url, headers } = sent();
    expect(url).toBe('https://gateway.ai.cloudflare.com/v1/account-1/sam/anthropic/v1/messages');
    expect(headers['cf-aig-metadata']).toBe(AIG_METADATA);
  });

  it('cloudflare: Workers AI goes through the gateway (control)', async () => {
    await forwardToWorkersAI(makeEnv('cloudflare'), CHAT, '@cf/m/x', AIG_METADATA);
    expect(sent().url).toBe(
      'https://gateway.ai.cloudflare.com/v1/account-1/sam/workers-ai/v1/chat/completions'
    );
  });

  it.each(PARTIAL)('%s: Anthropic goes straight to Anthropic without SAM ids', async (shape) => {
    fetchMock.mockResolvedValueOnce(Response.json(ANTHROPIC_OK));
    const res = await forwardToAnthropic(makeEnv(shape), CHAT, 'claude-sonnet-5', AIG_METADATA, {
      headers: { 'x-api-key': 'sk-platform-key' },
    } as Parameters<typeof forwardToAnthropic>[4]);
    expect(res.status).toBe(200);
    const { url, headers } = sent();
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect(headers['x-api-key']).toBe('sk-platform-key');
    expect(headers['cf-aig-metadata']).toBeUndefined();
  });

  it.each(PARTIAL)('%s: Workers AI uses the account REST API, as before', async (shape) => {
    const { response } = await forwardToWorkersAI(makeEnv(shape), CHAT, '@cf/m/x', AIG_METADATA);
    expect(response.status).toBe(200);
    const { url, headers } = sent();
    expect(url).toBe(
      'https://api.cloudflare.com/client/v4/accounts/account-1/ai/v1/chat/completions'
    );
    expect(headers.Authorization).toBe('Bearer cf-api-token');
  });
});

describe('monthly cost cron', () => {
  it('cloudflare: reads gateway logs (control)', async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        success: true,
        result: [],
        result_info: { page: 1, per_page: 50, count: 0, total_count: 0, total_pages: 1 },
      })
    );
    const result = await runMonthlyCostAggregation(makeEnv('cloudflare'));
    expect(result).toMatchObject({ enabled: true, errors: 0 });
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/ai-gateway/gateways/sam/logs');
  });

  it.each(PARTIAL)('%s: skips by design without reading gateway logs', async (shape) => {
    expect(await runMonthlyCostAggregation(makeEnv(shape))).toEqual({
      enabled: false,
      skipReason: 'ai_gateway_unavailable',
      usersUpdated: 0,
      totalEntries: 0,
      errors: 0,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
