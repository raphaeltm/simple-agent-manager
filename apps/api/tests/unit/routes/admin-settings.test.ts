import type Database from 'better-sqlite3';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import { createAdminSettingsEnv } from '../../helpers/admin-settings-env';
vi.mock('../../../src/middleware/auth', () => ({
  getAuth: (c: any) => c.get('auth'),
  requireAuth: () => async (c: any, next: () => Promise<void>) => {
    if (c.req.header('x-user') === 'none') return c.json({ error: 'UNAUTHORIZED' }, 401);
    c.set('auth', {
      user: {
        id: 'admin',
        status: c.req.header('x-status') ?? 'active',
        role: c.req.header('x-role') ?? 'superadmin',
      },
    });
    await next();
  },
  requireApproved: () => async (_c: any, next: () => Promise<void>) => next(),
  requireSuperadmin: () => async (c: any, next: () => Promise<void>) => {
    if (c.get('auth').user.role !== 'superadmin') return c.json({ error: 'FORBIDDEN' }, 403);
    await next();
  },
}));
const { adminSettingsRoutes } = await import('../../../src/routes/admin-settings');
let sqlite: Database.Database, bindings: Env;
beforeEach(() => {
  const fixture = createAdminSettingsEnv();
  sqlite = fixture.sqlite;
  bindings = fixture.env;
});
afterEach(() => {
  sqlite.close();
  vi.unstubAllGlobals();
});
const app = new Hono<{ Bindings: Env }>().route('/settings', adminSettingsRoutes);
const request = (headers: Record<string, string> = {}, body?: unknown) =>
  app.request(
    '/settings',
    {
      method: body ? 'PATCH' : 'GET',
      headers: { 'Content-Type': 'application/json', ...headers },
      ...(body ? { body: JSON.stringify(body) } : {}),
    },
    bindings
  );
describe('admin settings authorization and API', () => {
  it('requires authenticated active superadmin for GET and PATCH independently of approval-policy exemptions', async () => {
    for (const headers of [
      { 'x-user': 'none' },
      { 'x-role': 'admin' },
      { 'x-role': 'user' },
      { 'x-status': 'pending' },
      { 'x-status': 'suspended' },
      { 'x-status': 'system' },
      { 'x-status': 'unknown' },
    ]) {
      for (const body of [
        undefined,
        { expectedRevision: 0, changes: [{ name: 'operations.stalledTaskClassifierEnabled', value: false }] },
      ])
        expect((await request(headers, body)).status).toBe(
          headers['x-user'] === 'none' ? 401 : 403
        );
    }
    expect(sqlite.prepare('SELECT revision FROM admin_settings_revision').get()).toEqual({
      revision: 0,
    });
  });
  it('requires revision, rejects unknown fields and reports stale revisions', async () => {
    expect((await request()).status).toBe(200);
    expect((await request({}, { changes: [{ name: 'operations.stalledTaskClassifierEnabled', value: false }] })).status).toBe(
      400
    );
    expect(
      (
        await request(
          {},
          { expectedRevision: 0, changes: [{ name: 'operations.stalledTaskClassifierEnabled', value: false }], extra: 1 }
        )
      ).status
    ).toBe(400);
    expect(
      (
        await request(
          {},
          { expectedRevision: 0, changes: [{ name: 'operations.stalledTaskClassifierEnabled', value: false }] }
        )
      ).status
    ).toBe(200);
    expect(
      (
        await request(
          {},
          { expectedRevision: 0, changes: [{ name: 'operations.stalledTaskClassifierEnabled', value: true }] }
        )
      ).status
    ).toBe(409);
  });
  it('sanitizes SQL errors and never exposes value-derived diagnostics', async () => {
    sqlite.exec(
      "CREATE TRIGGER fail_write BEFORE INSERT ON platform_settings BEGIN SELECT RAISE(ABORT,'private-plaintext'); END;"
    );
    const response = await request(
      {},
      { expectedRevision: 0, changes: [{ name: 'operations.stalledTaskClassifierEnabled', value: false }] }
    );
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain('private-plaintext');
  });
});

describe('integration mutation guardrails', () => {
  const change = (provider: string, field: string, value: string | null) => ({
    name: `integration.${provider}.${field}`,
    value,
  });
  const patch = (changes: unknown[], expectedRevision = 0) =>
    request({}, { changes, expectedRevision });
  const unchanged = () => {
    expect(sqlite.prepare('SELECT revision FROM admin_settings_revision').get()).toEqual({
      revision: 0,
    });
    expect(sqlite.prepare('SELECT count(*) AS count FROM platform_credentials').get()).toEqual({
      count: 0,
    });
    expect(sqlite.prepare('SELECT count(*) AS count FROM admin_settings_audit').get()).toEqual({
      count: 0,
    });
  };
  it.each(['invalid_client', 'unauthorized_client'])(
    'rejects provider rejection %s before persistence',
    async (error) => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ error })));
      const response = await patch([
        change('google', 'clientId', 'valid-client-id'),
        change('google', 'clientSecret', 'valid-client-secret'),
      ]);
      expect(response.status).toBe(400);
      expect(await response.text()).not.toContain('valid-client-secret');
      unchanged();
    }
  );
  it('validates unchanged encrypted companions and reset environment fallbacks', async () => {
    const fetch = vi.fn(async (_url: unknown, _options: RequestInit) =>
      Response.json({ error: 'invalid_grant' })
    );
    vi.stubGlobal('fetch', fetch);
    expect(
      (
        await patch([
          change('google', 'clientId', 'stored-client-id'),
          change('google', 'clientSecret', 'stored-client-secret'),
        ])
      ).status
    ).toBe(200);
    expect((await patch([change('google', 'clientId', 'replacement-client-id')], 1)).status).toBe(
      200
    );
    expect(new URLSearchParams(fetch.mock.calls[1]![1].body as string).get('client_secret')).toBe(
      'stored-client-secret'
    );
    bindings.GOOGLE_LOGIN_CLIENT_ID = 'fallback-client-id';
    bindings.GOOGLE_LOGIN_CLIENT_SECRET = 'fallback-client-secret';
    fetch.mockImplementation(async () => Response.json({ error: 'invalid_client' }));
    expect(
      (await patch([change('google', 'clientId', null), change('google', 'clientSecret', null)], 2))
        .status
    ).toBe(400);
    const parameters = new URLSearchParams(fetch.mock.calls[2]![1].body as string);
    expect(parameters.get('client_id')).toBe('fallback-client-id');
    expect(parameters.get('client_secret')).toBe('fallback-client-secret');
    expect(sqlite.prepare('SELECT revision FROM admin_settings_revision').get()).toEqual({
      revision: 2,
    });
  });
  it('shares the existing atomic infrastructure rotation rate limit, including resets', async () => {
    bindings.RATE_LIMIT_CREDENTIAL_UPDATE = '1';
    const fetch = vi.fn().mockResolvedValue(Response.json({ error: 'invalid_client' }));
    vi.stubGlobal('fetch', fetch);
    expect(
      (
        await patch([
          change('googleInfrastructure', 'clientId', 'infra-client-id'),
          change('googleInfrastructure', 'clientSecret', 'infra-client-secret'),
        ])
      ).status
    ).toBe(400);
    expect(
      (
        await patch([
          change('googleInfrastructure', 'clientId', null),
          change('googleInfrastructure', 'clientSecret', null),
        ])
      ).status
    ).toBe(429);
    expect(fetch).toHaveBeenCalledTimes(1);
    unchanged();
  });
  it('rejects a concurrent revision change during provider validation', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async () => {
        sqlite.prepare('UPDATE admin_settings_revision SET revision=revision+1').run();
        return Response.json({ error: 'invalid_grant' });
      })
    );
    expect(
      (
        await patch([
          change('google', 'clientId', 'valid-client-id'),
          change('google', 'clientSecret', 'valid-client-secret'),
        ])
      ).status
    ).toBe(409);
    expect(sqlite.prepare('SELECT count(*) AS count FROM platform_credentials').get()).toEqual({
      count: 0,
    });
  });
});
