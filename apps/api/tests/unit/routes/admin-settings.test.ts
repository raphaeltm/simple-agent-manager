import type Database from 'better-sqlite3';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import { log } from '../../../src/lib/logger';
import { ADMIN_SETTINGS_REGISTRY } from '../../../src/services/admin-settings-registry';
import {
  invalidateAdminSettings,
  resolveAdminSetting,
} from '../../../src/services/admin-settings-resolution';
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
        {
          expectedRevision: 0,
          changes: [{ name: 'operations.stalledTaskClassifierEnabled', value: false }],
        },
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
    expect(
      (
        await request(
          {},
          { changes: [{ name: 'operations.stalledTaskClassifierEnabled', value: false }] }
        )
      ).status
    ).toBe(400);
    expect(
      (
        await request(
          {},
          {
            expectedRevision: 0,
            changes: [{ name: 'operations.stalledTaskClassifierEnabled', value: false }],
            extra: 1,
          }
        )
      ).status
    ).toBe(400);
    expect(
      (
        await request(
          {},
          {
            expectedRevision: 0,
            changes: [{ name: 'operations.stalledTaskClassifierEnabled', value: false }],
          }
        )
      ).status
    ).toBe(200);
    expect(
      (
        await request(
          {},
          {
            expectedRevision: 0,
            changes: [{ name: 'operations.stalledTaskClassifierEnabled', value: true }],
          }
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
      {
        expectedRevision: 0,
        changes: [{ name: 'operations.stalledTaskClassifierEnabled', value: false }],
      }
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
describe('OpenAI-compatible LLM endpoint settings', () => {
  const KEY = 'sk-endpoint-key-never-returned';
  it('stores the API key but never returns it, while the base URL reads back', async () => {
    const patch = await request(
      {},
      {
        expectedRevision: 0,
        changes: [
          { name: 'llm.openAICompatible.baseUrl', value: 'https://llm.example.com/v1' },
          { name: 'llm.openAICompatible.apiKey', value: KEY },
        ],
      }
    );
    expect(patch.status).toBe(200);
    expect(await patch.text()).not.toContain(KEY);

    const read = await request();
    expect(read.status).toBe(200);
    const text = await read.text();
    // Neither the settings nor their history carry the key; the plain setting does read back.
    expect(text).not.toContain(KEY);
    const body = JSON.parse(text) as { settings: Array<{ name: string; value: unknown }> };
    const byName = new Map(body.settings.map((setting) => [setting.name, setting]));
    expect(byName.get('llm.openAICompatible.baseUrl')?.value).toBe('https://llm.example.com/v1');
    expect(byName.get('llm.openAICompatible.apiKey')).toMatchObject({ configured: true });
    // Stored, but only as ciphertext.
    const rows = sqlite.prepare('SELECT * FROM platform_credentials').all();
    expect(rows.length).toBeGreaterThan(0);
    expect(JSON.stringify(rows)).not.toContain(KEY);
  });
});

describe('integration owner alerts', () => {
  const sent: Array<{ to: string; subject: string; text: string }> = [];
  beforeEach(() => {
    sent.length = 0;
    sqlite.exec(`
      CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT, name TEXT, role TEXT, status TEXT);
      INSERT INTO users VALUES ('admin', 'owner@example.com', 'Owner', 'superadmin', 'active');
    `);
    Object.assign(bindings, {
      BASE_DOMAIN: 'example.com',
      AGENT_EMAIL: {
        send: async (message: { to: string; subject: string; text: string }) => {
          sent.push(message);
          return { messageId: 'm' };
        },
      },
    });
  });

  it('emails the owners when an integration setting is set or reset from the settings page', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ error: 'invalid_grant' })));
    const response = await request(
      {},
      {
        expectedRevision: 0,
        changes: [
          { name: 'integration.google.clientId', value: 'stored-client-id' },
          { name: 'integration.google.clientSecret', value: 'stored-client-secret' },
        ],
      }
    );
    expect(response.status).toBe(200);
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]!.subject).toBe('SAM security alert: Google sign-in (OAuth) settings changed');
    expect(sent[0]!.text).toContain('By: Owner <owner@example.com>');
    expect(sent[0]!.text).not.toContain('stored-client-secret');
  });

  it('sends nothing for non-integration settings', async () => {
    const response = await request(
      {},
      {
        expectedRevision: 0,
        changes: [{ name: 'operations.stalledTaskClassifierEnabled', value: false }],
      }
    );
    expect(response.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(sent).toEqual([]);
  });
});

describe('stored setting validation fault isolation on SQLite D1', () => {
  const insert = (name: string, value: string) =>
    sqlite
      .prepare('INSERT INTO platform_settings(key,value,updated_at,updated_by) VALUES(?,?,?,?)')
      .run(name, value, '2026-11-16T12:00:00Z', 'admin');

  it('keeps good/bad/good overrides, flags the bad row, warns once without values, and resets it', async () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    try {
      insert('chat.messageMergingEnabled', 'false');
      insert('chat.profileUsageWindowDays', '-987654321');
      insert('operations.stalledTaskClassifierEnabled', 'false');
      const response = await request();
      expect(response.status).toBe(200);
      const view = await response.json();
      expect(view.settings).toHaveLength(ADMIN_SETTINGS_REGISTRY.length);
      const bad = view.settings.find((s: any) => s.name === 'chat.profileUsageWindowDays');
      expect(bad).toMatchObject({
        source: 'default',
        configured: false,
        storedValueInvalid: true,
        storedValue: '-987654321',
        value: bad.defaultValue,
        updatedAt: '2026-11-16T12:00:00Z',
        updatedBy: 'admin',
      });
      for (const name of [
        'chat.messageMergingEnabled',
        'operations.stalledTaskClassifierEnabled',
      ]) {
        expect(view.settings.find((s: any) => s.name === name)).toMatchObject({
          value: false,
          source: 'database',
          configured: true,
        });
        expect(view.settings.find((s: any) => s.name === name)).not.toHaveProperty(
          'storedValueInvalid'
        );
      }
      expect(await resolveAdminSetting(bindings, 'chat.profileUsageWindowDays')).toBe(
        bad.defaultValue
      );
      expect((await request()).status).toBe(200);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(
        'admin_settings.invalid_stored_value',
        expect.objectContaining({
          key: 'chat.profileUsageWindowDays',
          context: 'platform_settings',
          action: 'show_fallback',
        })
      );
      expect(JSON.stringify(warn.mock.calls)).not.toContain('-987654321');
      const reset = await request(
        {},
        {
          expectedRevision: view.revision,
          changes: [{ name: bad.name, value: null }],
        }
      );
      expect(reset.status).toBe(200);
      const after = await reset.json();
      expect(after.settings.find((s: any) => s.name === bad.name)).not.toHaveProperty(
        'storedValueInvalid'
      );
      expect(
        sqlite.prepare('SELECT key FROM platform_settings WHERE key=?').get(bad.name)
      ).toBeUndefined();
    } finally {
      warn.mockRestore();
    }
  });

  it('returns defaults even when every stored override is invalid', async () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    try {
      insert('chat.profileUsageWindowDays', 'invalid-private-text');
      insert('chat.profilePinCandidateLimit', '-1');
      const response = await request();
      expect(response.status).toBe(200);
      const view = await response.json();
      expect(view.settings.filter((s: any) => s.storedValueInvalid)).toHaveLength(2);
      for (const item of view.settings.filter((s: any) => s.storedValueInvalid))
        expect(item).toMatchObject({ value: item.defaultValue, source: 'default' });
      expect(JSON.stringify(warn.mock.calls)).not.toContain('invalid-private-text');
    } finally {
      warn.mockRestore();
    }
  });

  it('leaves a valid stored row identical to its preexisting contract', async () => {
    insert('chat.profileUsageWindowDays', '7');
    const response = await request();
    expect(response.status).toBe(200);
    const view = await response.json();
    const definition = ADMIN_SETTINGS_REGISTRY.find(
      (s) => s.name === 'chat.profileUsageWindowDays'
    )!;
    expect(view.settings.find((s: any) => s.name === definition.name)).toMatchObject({
      value: 7,
      source: 'database',
      configured: true,
      updatedAt: '2026-11-16T12:00:00Z',
      updatedBy: 'admin',
    });
    expect(view.settings.find((s: any) => s.name === definition.name)).not.toHaveProperty(
      'storedValueInvalid'
    );
  });
});

it.each([
  ['connector.enabled', false],
  ['connector.writeEnabled', false],
  ['connector.clientRegistration', 'allowlist'],
  ['connector.allowedRedirectHosts', []],
  ['operations.samOperatorDisabled', true],
] as const)('reports the actual fail-closed fallback for invalid %s', async (name, expected) => {
  const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
  try {
    sqlite
      .prepare('INSERT INTO platform_settings(key,value,updated_at) VALUES(?,?,?)')
      .run(name, '[1]', '2026-11-16');
    const response = await request();
    expect(response.status).toBe(200);
    const view = await response.json();
    expect(view.settings.find((item: any) => item.name === name)).toMatchObject({
      value: expected,
      storedValueInvalid: true,
      source: 'default',
    });
    expect(await resolveAdminSetting(bindings, name)).toEqual(expected);
  } finally {
    warn.mockRestore();
  }
});

it('keeps emergency KV vetoes for invalid overrides', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    sqlite
      .prepare('INSERT INTO platform_settings(key,value,updated_at) VALUES(?,?,?)')
      .run('operations.cronSweepsEnabled', 'invalid', '2026-11-16');
    await bindings.KV.put('control-loops:cron-enabled', 'false');
    const response = await request();
    expect(response.status).toBe(200);
    const view = await response.json();
    expect(
      view.settings.find((item: any) => item.name === 'operations.cronSweepsEnabled')
    ).toMatchObject({ value: false, storedValueInvalid: true, storedValueFallback: 'safe' });
    expect(await resolveAdminSetting(bindings, 'operations.cronSweepsEnabled')).toBe(false);
  } finally {
    warn.mockRestore();
  }
});

it('keeps a previously observed false brake for an invalid boolean row', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    const name = 'operations.stalledTaskClassifierEnabled';
    sqlite
      .prepare('INSERT INTO platform_settings(key,value,updated_at) VALUES(?,?,?)')
      .run(name, 'false', '2026-11-16');
    expect(await resolveAdminSetting(bindings, name)).toBe(false);
    sqlite.prepare('UPDATE platform_settings SET value=? WHERE key=?').run('invalid', name);
    invalidateAdminSettings(bindings);
    const response = await request();
    const view = await response.json();
    expect(response.status).toBe(200);
    expect(view.settings.find((item: any) => item.name === name)).toMatchObject({
      value: false,
      storedValueInvalid: true,
      storedValueFallback: 'safe',
    });
    expect(await resolveAdminSetting(bindings, name)).toBe(false);
  } finally {
    warn.mockRestore();
  }
});

it('never exposes stale secret override text in the list or its diagnostics', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    sqlite
      .prepare('INSERT INTO platform_settings(key,value,updated_at) VALUES(?,?,?)')
      .run('integration.github.clientSecret', 'private-stale-secret', '2026-11-16');
    sqlite
      .prepare('INSERT INTO platform_settings(key,value,updated_at) VALUES(?,?,?)')
      .run('chat.profileUsageWindowDays', '-1', '2026-11-16');
    const response = await request();
    expect(response.status).toBe(200);
    expect(await response.text()).not.toContain('private-stale-secret');
    expect(JSON.stringify(warn.mock.calls)).not.toContain('private-stale-secret');
  } finally {
    warn.mockRestore();
  }
});

it('keeps canonical tool merging OFF by default and accepts only a typed boolean kill switch', async () => {
  expect(await resolveAdminSetting(bindings, 'chat.toolCallMergingEnabled')).toBe(false);
  expect(
    (
      await request(
        {},
        { expectedRevision: 0, changes: [{ name: 'chat.toolCallMergingEnabled', value: 'true' }] }
      )
    ).status
  ).toBe(400);
  expect(
    (
      await request(
        {},
        { expectedRevision: 0, changes: [{ name: 'chat.toolCallMergingEnabled', value: true }] }
      )
    ).status
  ).toBe(200);
  await invalidateAdminSettings(bindings);
  expect(await resolveAdminSetting(bindings, 'chat.toolCallMergingEnabled')).toBe(true);
  expect(
    (
      await request(
        {},
        { expectedRevision: 1, changes: [{ name: 'chat.toolCallMergingEnabled', value: false }] }
      )
    ).status
  ).toBe(200);
  await invalidateAdminSettings(bindings);
  expect(await resolveAdminSetting(bindings, 'chat.toolCallMergingEnabled')).toBe(false);
});
