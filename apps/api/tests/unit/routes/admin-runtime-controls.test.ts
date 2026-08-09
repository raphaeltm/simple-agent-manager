import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';

vi.mock('../../../src/middleware/auth', () => ({
  requireAuth: () => vi.fn((_c: unknown, next: () => Promise<void>) => next()),
  requireApproved: () => vi.fn((_c: unknown, next: () => Promise<void>) => next()),
  requireSuperadmin: () => vi.fn((_c: unknown, next: () => Promise<void>) => next()),
}));

const { adminRuntimeControlRoutes } = await import('../../../src/routes/admin-runtime-controls');
const { __resetOperationalKillSwitchCacheForTest } = await import(
  '../../../src/services/operational-kill-switch'
);

function createApp() {
  const app = new Hono<{ Bindings: Env }>();
  app.route('/api/admin/runtime-controls', adminRuntimeControlRoutes);
  return app;
}

describe('admin runtime controls', () => {
  beforeEach(() => __resetOperationalKillSwitchCacheForTest());

  it('reads both fail-open switches', async () => {
    const get = vi.fn().mockResolvedValue(null);
    const env = { KV: { get, put: vi.fn() } } as unknown as Env;

    const response = await createApp().request('/api/admin/runtime-controls', {}, env);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      cronSweepsEnabled: true,
      doAlarmsEnabled: true,
      semantics: 'fail-open',
    });
  });

  it('flips both switches and returns the updated state', async () => {
    const values = new Map<string, string>();
    const env = {
      KV: {
        get: vi.fn(async (key: string) => values.get(key) ?? null),
        put: vi.fn(async (key: string, value: string) => { values.set(key, value); }),
      },
    } as unknown as Env;

    const response = await createApp().request('/api/admin/runtime-controls', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cronSweepsEnabled: false, doAlarmsEnabled: false }),
    }, env);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      cronSweepsEnabled: false,
      doAlarmsEnabled: false,
    });
    expect(values).toEqual(new Map([
      ['control-loops:cron-enabled', 'false'],
      ['control-loops:alarms-enabled', 'false'],
    ]));
  });
});
