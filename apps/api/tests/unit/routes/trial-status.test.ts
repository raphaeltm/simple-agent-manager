/**
 * `routes/trial.ts` behaviour.
 *
 * Authenticated GET /api/trial-status reports current-user platform compute
 * eligibility (installation platform credential + AI proxy), budget and usage.
 *
 * Every `/api/trial/*` path belonged to the retired anonymous-trial product and
 * now answers 410 Gone for every method without touching any binding.
 */
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';

vi.mock('../../../src/lib/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('drizzle-orm/d1', () => ({
  drizzle: vi.fn(() => ({})),
}));

vi.mock('../../../src/middleware/auth', () => ({
  requireAuth: () => vi.fn((_c: unknown, next: () => Promise<void>) => next()),
  requireApproved: () => vi.fn((_c: unknown, next: () => Promise<void>) => next()),
  getUserId: () => 'user-1',
}));

const { getTrialStatusMock } = vi.hoisted(() => ({
  getTrialStatusMock: vi.fn(),
}));

vi.mock('../../../src/services/platform-trial', () => ({
  getTrialStatus: getTrialStatusMock,
}));

const { trialRoutes } = await import('../../../src/routes/trial');

/** An Env whose every binding access fails the test: retired routes must not read any. */
function untouchableEnv(): { env: Env; touched: string[] } {
  const touched: string[] = [];
  const env = new Proxy({} as Env, {
    get(_target, property) {
      if (typeof property === 'string') touched.push(property);
      return undefined;
    },
  });
  return { env, touched };
}

describe('retired anonymous-trial endpoints under /api/trial', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const RETIRED: Array<[method: string, path: string]> = [
    ['POST', '/api/trial/create'],
    ['POST', '/api/trial/claim'],
    ['GET', '/api/trial/status'],
    ['POST', '/api/trial/waitlist'],
    ['GET', '/api/trial/trial_01ABC/events'],
    ['GET', '/api/trial'],
    ['DELETE', '/api/trial/anything/else'],
  ];

  it.each(RETIRED)('%s %s answers 410 Gone without reading any binding', async (method, path) => {
    const app = new Hono<{ Bindings: Env }>();
    app.route('/api', trialRoutes);
    const { env, touched } = untouchableEnv();

    const res = await app.fetch(
      new Request(`https://api.test${path}`, {
        method,
        headers: { 'content-type': 'application/json', cookie: 'sam_trial_claim=stale' },
        body: method === 'GET' ? undefined : JSON.stringify({ repoUrl: 'https://github.com/a/b' }),
      }),
      env
    );

    expect(res.status).toBe(410);
    await expect(res.json()).resolves.toMatchObject({ error: 'GONE' });
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(touched).toEqual([]);
    expect(getTrialStatusMock).not.toHaveBeenCalled();
  });

  it('keeps /api/trial-status (platform availability) distinct from the retired prefix', async () => {
    getTrialStatusMock.mockResolvedValue({ available: false });
    const app = new Hono<{ Bindings: Env }>();
    app.route('/api', trialRoutes);
    const res = await app.fetch(new Request('https://api.test/api/trial-status'), {} as Env);
    expect(res.status).toBe(200);
    expect(getTrialStatusMock).toHaveBeenCalledOnce();
  });
});

function makeAuthenticatedTrialApp(env: Env) {
  const app = new Hono<{ Bindings: Env }>();
  app.route('/api', trialRoutes);
  return { app, env };
}

async function getAuthenticatedTrialStatus(app: Hono<{ Bindings: Env }>, env: Env) {
  return app.fetch(new Request('https://api.test/api/trial-status'), env);
}

describe('authenticated GET /api/trial-status current-user platform eligibility', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(drizzle).mockReturnValue({} as ReturnType<typeof drizzle>);
  });

  it('returns the current user platform trial eligibility response', async () => {
    const platformStatus = {
      available: true,
      agentType: 'opencode' as const,
      hasInfraCredential: true,
      hasAgentCredential: true,
      dailyTokenBudget: { input: 500_000, output: 200_000 },
      dailyTokenUsage: { input: 123, output: 45 },
    };
    getTrialStatusMock.mockResolvedValue(platformStatus);
    const env = {
      DATABASE: {} as D1Database,
      ENCRYPTION_KEY: 'test-encryption-key',
      KV: {} as KVNamespace,
    } as Env;
    const { app } = makeAuthenticatedTrialApp(env);

    const res = await getAuthenticatedTrialStatus(app, env);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual(platformStatus);
    expect(getTrialStatusMock).toHaveBeenCalledWith({}, 'user-1', env);
  });

  it('fails closed when current-user platform eligibility lookup throws', async () => {
    getTrialStatusMock.mockRejectedValue(new Error('invalid platform token limit'));
    const env = {
      DATABASE: {} as D1Database,
      ENCRYPTION_KEY: 'test-encryption-key',
      KV: {} as KVNamespace,
    } as Env;
    const { app } = makeAuthenticatedTrialApp(env);

    const res = await getAuthenticatedTrialStatus(app, env);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      available: false,
      agentType: null,
      hasInfraCredential: false,
      hasAgentCredential: false,
      dailyTokenBudget: null,
      dailyTokenUsage: null,
    });
  });
});
