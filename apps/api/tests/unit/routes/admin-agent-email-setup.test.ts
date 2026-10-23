/**
 * The superadmin agent email setup through the real route and auth gates, a real SQLite
 * database and a fake Cloudflare zone. Only the session lookup is pre-set: `requireAuth` skips
 * it when the request already carries an auth context.
 */
import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { handleAppError } from '../../../src/middleware/app-error-handler';
import { adminAgentEmailRoutes } from '../../../src/routes/admin-agent-email';
import {
  cloudflareError,
  cloudflareRoutingFirstUse,
  FAKE_CF_ZONE_ID,
  fakeCloudflareEmail,
  type FakeCloudflareEmailOptions,
} from '../../helpers/fake-cloudflare-email';
import { createAllSchemaTables, createMemoryKv, createSqliteD1 } from '../../helpers/sqlite-d1';

const MAIN = 'fixture.example';
const DOMAIN = `agents.${MAIN}`;
const NEW_ZONE: FakeCloudflareEmailOptions = { sending: [{ name: DOMAIN, enabled: true }] };

type Role = 'superadmin' | 'admin' | 'user';

describe('admin agent email setup route', () => {
  let sqlite: Database.Database;
  let env: Env;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    createAllSchemaTables(sqlite, schema);
    env = {
      DATABASE: createSqliteD1(sqlite),
      KV: createMemoryKv(),
      BASE_DOMAIN: MAIN,
      CF_ZONE_ID: FAKE_CF_ZONE_ID,
      CF_API_TOKEN: 'cf-token',
      AGENT_EMAIL: { send: vi.fn() } as unknown as SendEmail,
      AGENT_EMAIL_WORKER_NAME: 'sam-api-fixture',
    } as Env;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    sqlite.close();
  });

  function cloudflare(options: FakeCloudflareEmailOptions) {
    const fake = fakeCloudflareEmail(options);
    vi.stubGlobal('fetch', fake.fetchMock);
    return fake;
  }

  function appAs(role: Role) {
    const app = new Hono<{ Bindings: Env }>();
    app.onError(handleAppError);
    app.use('*', async (c, next) => {
      c.set('auth', {
        user: {
          id: `${role}-1`,
          email: `${role}@example.com`,
          name: role,
          avatarUrl: null,
          role,
          status: 'active',
        },
        session: { id: 'session-1', token: 'token-1', expiresAt: new Date(Date.now() + 3_600_000) },
      });
      // Signup approval is a separate gate with its own tests; keep it out of the way.
      c.set('signupApprovalRequired', false);
      await next();
    });
    app.route('/api/admin/agent-email', adminAgentEmailRoutes);
    return app;
  }

  const getPlan = (app: Hono<{ Bindings: Env }>) =>
    app.request('/api/admin/agent-email/setup', {}, env);
  const postSetup = (app: Hono<{ Bindings: Env }>, body: unknown) =>
    app.request(
      '/api/admin/agent-email/setup',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
      env
    );

  it('lets only a superadmin read the plan or run the setup', async () => {
    const fake = cloudflare(NEW_ZONE);
    for (const role of ['admin', 'user'] as const) {
      const app = appAs(role);
      expect((await getPlan(app)).status, role).toBe(403);
      expect((await postSetup(app, { allowMainDomainChanges: true })).status, role).toBe(403);
    }
    expect(fake.calls).toEqual([]);
  });

  it('shows the main domain changes, refuses without consent, and turns agent email on with it', async () => {
    const fake = cloudflare(NEW_ZONE);
    const app = appAs('superadmin');

    const plan = await getPlan(app);
    expect(plan.status).toBe(200);
    expect(await plan.json()).toMatchObject({
      state: 'needs_consent',
      domain: DOMAIN,
      mainDomain: MAIN,
      mainDomainChanges: [
        { type: 'TXT', name: MAIN, content: 'v=spf1 include:_spf.mx.cloudflare.net ~all' },
        { type: 'TXT', name: `cf2024-1._domainkey.${MAIN}`, content: null },
      ],
    });

    const refused = await postSetup(app, {});
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({
      error: 'CONFLICT',
      message: `Allow the changes to ${MAIN} to turn agent email on.`,
    });
    expect(fake.writes()).toEqual([]);
    expect(await (await app.request('/api/admin/agent-email', {}, env)).json()).toMatchObject({
      enabled: false,
      domain: null,
    });

    const done = await postSetup(app, { allowMainDomainChanges: true });
    expect(done.status).toBe(200);
    expect(await done.json()).toMatchObject({ state: 'on', domain: DOMAIN });
    expect(await (await app.request('/api/admin/agent-email', {}, env)).json()).toMatchObject({
      enabled: true,
      domain: DOMAIN,
    });
    expect(
      sqlite
        .prepare('SELECT updated_by FROM platform_settings WHERE key = ?')
        .get('agent_email.setup')
    ).toEqual({ updated_by: 'superadmin-1' });

    expect(await (await postSetup(app, {})).json()).toMatchObject({ state: 'on' });
  });

  it('rejects a malformed body before calling Cloudflare', async () => {
    const fake = cloudflare(NEW_ZONE);
    const response = await postSetup(appAs('superadmin'), { allowMainDomainChanges: 'yes' });
    expect(response.status).toBe(400);
    expect(fake.calls).toEqual([]);
  });

  it('answers 409 with the records when the main domain changed beyond what it showed', async () => {
    cloudflare({
      ...NEW_ZONE,
      firstUseAdds: (zone) => [
        ...cloudflareRoutingFirstUse(zone),
        { type: 'TXT', name: zone, content: '"v=spf1 include:example.net -all"' },
      ],
    });
    const response = await postSetup(appAs('superadmin'), { allowMainDomainChanges: true });
    expect(response.status).toBe(409);
    expect((await response.json()).message).toContain('added TXT v=spf1 include:example.net -all');
  });

  it('answers 502 with Cloudflare’s code when a Cloudflare call fails', async () => {
    cloudflare({
      ...NEW_ZONE,
      respond: (call) =>
        call.path === '/email/sending/subdomains'
          ? cloudflareError(403, 10000, 'Authentication error')
          : undefined,
    });
    const app = appAs('superadmin');
    for (const response of [await getPlan(app), await postSetup(app, {})]) {
      expect(response.status).toBe(502);
      expect(await response.json()).toMatchObject({
        error: 'CLOUDFLARE_ERROR',
        message:
          'Cloudflare GET /email/sending/subdomains failed with HTTP 403: 10000 Authentication error',
      });
    }
  });
});
