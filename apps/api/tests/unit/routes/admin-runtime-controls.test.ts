import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import { handleAppError } from '../../../src/middleware/app-error-handler';
import { createMemoryKv } from '../../helpers/sqlite-d1';

vi.mock('../../../src/middleware/auth', () => ({
  requireAuth: () => vi.fn((_c: unknown, next: () => Promise<void>) => next()),
  requireApproved: () => vi.fn((_c: unknown, next: () => Promise<void>) => next()),
  requireSuperadmin: () =>
    vi.fn(
      (
        c: {
          req: { header: (name: string) => string | undefined };
          json: (body: unknown, status: 403) => Response;
        },
        next: () => Promise<void>
      ) =>
        c.req.header('x-test-role') === 'superadmin'
          ? next()
          : c.json({ error: 'FORBIDDEN', message: 'Superadmin access required' }, 403)
    ),
}));

const { adminRuntimeControlRoutes } = await import('../../../src/routes/admin-runtime-controls');
const { __resetOperationalKillSwitchCacheForTest } =
  await import('../../../src/services/operational-kill-switch');

function createApp() {
  const app = new Hono<{ Bindings: Env }>();
  // Pre-existing tests never exercised a thrown AppError path (only the
  // hand-rolled 403 response and, later, jsonValidator's own direct 400
  // response), so this app had no onError — thrown errors.badRequest(...)
  // calls fell through to Hono's default 500. Register the production
  // handler so the new validation-preserved-message tests below see the
  // same 400 shape the real app returns.
  app.onError(handleAppError);
  app.route('/api/admin/runtime-controls', adminRuntimeControlRoutes);
  return app;
}

describe('admin runtime controls', () => {
  beforeEach(() => __resetOperationalKillSwitchCacheForTest());

  it('reads both fail-open switches', async () => {
    const get = vi.fn().mockResolvedValue(null);
    const env = { KV: { get, put: vi.fn() } } as unknown as Env;

    const response = await createApp().request(
      '/api/admin/runtime-controls',
      { headers: { 'x-test-role': 'superadmin' } },
      env
    );

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
        put: vi.fn(async (key: string, value: string) => {
          values.set(key, value);
        }),
      },
    } as unknown as Env;

    const response = await createApp().request(
      '/api/admin/runtime-controls',
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'x-test-role': 'superadmin' },
        body: JSON.stringify({ cronSweepsEnabled: false, doAlarmsEnabled: false }),
      },
      env
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      cronSweepsEnabled: false,
      doAlarmsEnabled: false,
    });
    expect(values).toEqual(
      new Map([
        ['control-loops:cron-enabled', 'false'],
        ['control-loops:alarms-enabled', 'false'],
      ])
    );
  });

  it('rejects a non-superadmin before reading either switch', async () => {
    const get = vi.fn();
    const env = { KV: { get, put: vi.fn() } } as unknown as Env;

    const response = await createApp().request(
      '/api/admin/runtime-controls',
      { headers: { 'x-test-role': 'user' } },
      env
    );

    expect(response.status).toBe(403);
    expect(get).not.toHaveBeenCalled();
  });

  it('rejects a malformed JSON body with the standard jsonValidator 400 shape', async () => {
    // createMemoryKv() is already typed as a real KVNamespace, so `{ KV: kv }
    // as Env` needs no `unknown` intermediate step — see
    // admin-observability-vertical.test.ts for the same single-step pattern.
    const kv = createMemoryKv();
    const putSpy = vi.spyOn(kv, 'put');
    const env = { KV: kv } as Env;

    const response = await createApp().request(
      '/api/admin/runtime-controls',
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'x-test-role': 'superadmin' },
        body: '{not valid json',
      },
      env
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'BAD_REQUEST' });
    expect(putSpy).not.toHaveBeenCalled();
  });

  it('preserves the handler-produced message when neither field is present', async () => {
    const kv = createMemoryKv();
    const putSpy = vi.spyOn(kv, 'put');
    const env = { KV: kv } as Env;

    const response = await createApp().request(
      '/api/admin/runtime-controls',
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'x-test-role': 'superadmin' },
        body: JSON.stringify({}),
      },
      env
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      message: 'Provide cronSweepsEnabled and/or doAlarmsEnabled',
    });
    expect(putSpy).not.toHaveBeenCalled();
  });

  it('preserves the handler-produced message for a wrong-type field', async () => {
    const kv = createMemoryKv();
    const putSpy = vi.spyOn(kv, 'put');
    const env = { KV: kv } as Env;

    const response = await createApp().request(
      '/api/admin/runtime-controls',
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'x-test-role': 'superadmin' },
        body: JSON.stringify({ cronSweepsEnabled: 'yes' }),
      },
      env
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      message: 'cronSweepsEnabled must be a boolean',
    });
    expect(putSpy).not.toHaveBeenCalled();
  });
});
