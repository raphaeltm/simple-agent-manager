/**
 * Behavioral tests for GET /api/trial/status.
 *
 * Verifies:
 *   - Happy path: enabled=true, remaining = cap - count, resetsAt = next month
 *   - Cap exhausted: remaining = 0 (clamped), enabled still reflects kill-switch
 *   - Cap = 0 (unlimited): remaining = Number.MAX_SAFE_INTEGER
 *   - Kill-switch off: enabled=false
 *   - DO failure: enabled=false, remaining=0 (fail-closed fallback)
 */
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';

vi.mock('../../../src/lib/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { isTrialsEnabledMock } = vi.hoisted(() => ({
  isTrialsEnabledMock: vi.fn(),
}));

vi.mock('../../../src/services/trial/kill-switch', () => ({
  isTrialsEnabled: isTrialsEnabledMock,
}));

const { statusRoutes } = await import('../../../src/routes/trial/status');

function makeEnv(options: {
  doGet?: (key: string) => Promise<{ monthKey: string; count: number }>;
  cap?: string;
}): Env {
  return {
    TRIAL_MONTHLY_CAP: options.cap,
    TRIAL_COUNTER: {
      idFromName: vi.fn(() => 'do-id'),
      get: vi.fn(() => ({
        get:
          options.doGet ??
          vi.fn(async (key: string) => ({ monthKey: key, count: 0 })),
      })),
    },
  } as unknown as Env;
}

function makeApp(env: Env) {
  const app = new Hono<{ Bindings: Env }>();
  app.route('/api/trial', statusRoutes);
  return { app, env };
}

async function getStatus(app: Hono<{ Bindings: Env }>, env: Env) {
  return app.fetch(new Request('https://api.test/api/trial/status'), env);
}

describe('GET /api/trial/status', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns enabled + remaining computed from cap and DO count', async () => {
    isTrialsEnabledMock.mockResolvedValue(true);
    const doGet = vi.fn().mockResolvedValue({ monthKey: '2026-04', count: 500 });
    const { app, env } = makeApp(makeEnv({ doGet, cap: '1500' }));

    const res = await getStatus(app, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      enabled: boolean;
      remaining: number;
      resetsAt: string;
    };
    expect(body.enabled).toBe(true);
    expect(body.remaining).toBe(1000);
    expect(body.resetsAt).toMatch(/^\d{4}-\d{2}-01$/);
  });

  it('clamps remaining to 0 when cap is exhausted', async () => {
    isTrialsEnabledMock.mockResolvedValue(true);
    const doGet = vi.fn().mockResolvedValue({ monthKey: '2026-04', count: 1500 });
    const { app, env } = makeApp(makeEnv({ doGet, cap: '1500' }));

    const res = await getStatus(app, env);
    const body = (await res.json()) as { remaining: number };
    expect(body.remaining).toBe(0);
  });

  it('returns MAX_SAFE_INTEGER when cap=0 (unlimited)', async () => {
    isTrialsEnabledMock.mockResolvedValue(true);
    const doGet = vi.fn().mockResolvedValue({ monthKey: '2026-04', count: 42 });
    const { app, env } = makeApp(makeEnv({ doGet, cap: '0' }));

    const res = await getStatus(app, env);
    const body = (await res.json()) as { remaining: number };
    expect(body.remaining).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('returns enabled=false when kill-switch is off', async () => {
    isTrialsEnabledMock.mockResolvedValue(false);
    const { app, env } = makeApp(makeEnv({}));

    const res = await getStatus(app, env);
    const body = (await res.json()) as { enabled: boolean };
    expect(body.enabled).toBe(false);
  });

  it('fails closed (enabled=false, remaining=0) when DO throws', async () => {
    isTrialsEnabledMock.mockResolvedValue(true);
    const doGet = vi.fn().mockRejectedValue(new Error('DO unreachable'));
    const { app, env } = makeApp(makeEnv({ doGet }));

    const res = await getStatus(app, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      enabled: boolean;
      remaining: number;
      resetsAt: string;
    };
    expect(body.enabled).toBe(false);
    expect(body.remaining).toBe(0);
    expect(body.resetsAt).toMatch(/^\d{4}-\d{2}-01$/);
  });
});
