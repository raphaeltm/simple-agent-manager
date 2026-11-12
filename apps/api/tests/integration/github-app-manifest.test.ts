/**
 * GitHub App creation through GitHub's manifest flow, end to end: the production admin routes
 * (real session auth and superadmin gates), a real SQL engine and KV, and the real platform
 * config store. Only GitHub is faked, at the network boundary.
 */
import { readFileSync } from 'node:fs';

import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../src/db/schema';
import type { Env } from '../../src/env';
import { handleAppError } from '../../src/middleware/app-error-handler';
import { adminPlatformConfigRoutes } from '../../src/routes/admin-platform-config';
import { githubRoutes } from '../../src/routes/github';
import { generateEncryptionKey } from '../../src/services/encryption';
import {
  GITHUB_APP_MANIFEST_EVENTS,
  GITHUB_APP_MANIFEST_PERMISSIONS,
} from '../../src/services/github-app-manifest';
import {
  __resetPlatformConfigCacheForTest,
  getGitHubAppConfig,
  resolvePlatformConfig,
} from '../../src/services/platform-config';
import { createSessionCookieForUser } from '../../src/services/session-factory';
import { createAllSchemaTables, createMemoryKv, createSqliteD1 } from '../helpers/sqlite-d1';

const API = 'https://api.example.com';
const PEM =
  '-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBAKj34GkxFhD90vcNLYLInFEX6Ppy1tPf9Cnzj4p4WGeKLs1Pt8Qu\n-----END RSA PRIVATE KEY-----\n';

function createFakeGitHub() {
  const codes = new Map<string, Record<string, unknown>>();
  const conversions: string[] = [];
  async function fetchImpl(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const match = /^\/app-manifests\/([^/]+)\/conversions$/.exec(url.pathname);
    if (request.method === 'POST' && url.origin === 'https://api.github.com' && match) {
      const code = decodeURIComponent(match[1] ?? '');
      conversions.push(code);
      const app = codes.get(code);
      codes.delete(code); // single use, as on GitHub
      if (!app) return Response.json({ message: 'Not Found' }, { status: 404 });
      return Response.json(app, { status: 201 });
    }
    // SAM's OAuth client probe: a valid client gets "bad code", never "incorrect credentials".
    if (request.method === 'POST' && url.href === 'https://github.com/login/oauth/access_token') {
      return Response.json({ error: 'bad_verification_code' });
    }
    throw new Error(`Unexpected outbound request: ${request.method} ${request.url}`);
  }
  /** The administrator confirms on GitHub; GitHub creates the App and issues a code. */
  function createAppFromManifest(manifest: Record<string, unknown>): string {
    const code = `manifest-code-${codes.size + conversions.length + 1}`;
    codes.set(code, {
      id: 123456,
      slug: 'sam-example-com',
      name: manifest.name,
      html_url: 'https://github.com/apps/sam-example-com',
      owner: { login: 'octo' },
      client_id: 'Iv23liExampleClient',
      client_secret: 'client-secret-0123456789abcdef',
      webhook_secret: 'webhook-secret-0123456789abcdef',
      pem: PEM,
    });
    return code;
  }
  return { fetch: fetchImpl, createAppFromManifest, conversions };
}

describe('GitHub App manifest flow (vertical slice)', () => {
  let sqlite: Database.Database;
  let env: Env;
  let github: ReturnType<typeof createFakeGitHub>;
  const app = new Hono<{ Bindings: Env }>();
  app.onError(handleAppError);
  app.route('/api/admin/platform-config', adminPlatformConfigRoutes);
  app.route('/api/github', githubRoutes);

  beforeEach(() => {
    sqlite = new Database(':memory:');
    createAllSchemaTables(sqlite, schema);
    // The admin-settings store the platform config writes through (not in the drizzle schema).
    sqlite.exec(
      readFileSync(
        new URL('../../src/db/migrations/0196_admin_settings.sql', import.meta.url),
        'utf8'
      )
    );
    env = {
      DATABASE: createSqliteD1(sqlite),
      KV: createMemoryKv(),
      BASE_DOMAIN: 'example.com',
      ENCRYPTION_KEY: generateEncryptionKey(),
    } as Env;
    __resetPlatformConfigCacheForTest();
    github = createFakeGitHub();
    vi.stubGlobal('fetch', github.fetch);
    for (const [id, role] of [
      ['admin', 'superadmin'],
      ['other-admin', 'superadmin'],
      ['member', 'user'],
    ] as const) {
      sqlite
        .prepare(
          `INSERT INTO users (id, email, email_verified, name, role, status, created_at, updated_at)
           VALUES (?, ?, 1, ?, ?, 'active', 1, 1)`
        )
        .run(id, `${id}@example.com`, id, role);
    }
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    sqlite.close();
  });

  async function cookieFor(userId: string) {
    return (await createSessionCookieForUser(env, userId)).sessionCookie;
  }

  async function post(path: string, cookie: string, body: unknown) {
    return app.request(
      `${API}${path}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify(body),
      },
      env
    );
  }

  async function start(cookie: string, body: unknown = {}) {
    const response = await post('/api/admin/platform-config/github-app/manifest', cookie, body);
    return {
      response,
      body: (await response.json()) as {
        postUrl: string;
        state: string;
        manifest: Record<string, unknown>;
      },
    };
  }

  it('builds the manifest with SAM URLs and permissions, and stores the converted App', async () => {
    const admin = await cookieFor('admin');

    // Before: the install URL is a clear setup message, not a 500.
    const before = await app.request(
      `${API}/api/github/install-url`,
      { headers: { cookie: admin } },
      env
    );
    expect(before.status).toBe(409);
    expect(await before.json()).toMatchObject({ error: 'GITHUB_APP_NOT_CONFIGURED' });

    const started = await start(admin, { name: 'SAM test box' });
    expect(started.response.status).toBe(200);
    expect(started.body.postUrl).toBe(
      `https://github.com/settings/apps/new?state=${started.body.state}`
    );
    expect(started.body.manifest).toMatchObject({
      name: 'SAM test box',
      url: 'https://app.example.com',
      public: false,
      redirect_url: 'https://app.example.com/admin/integrations',
      callback_urls: ['https://api.example.com/api/auth/callback/github'],
      setup_url: 'https://api.example.com/api/github/callback',
      setup_on_update: true,
      request_oauth_on_install: false,
      hook_attributes: { url: 'https://api.example.com/api/github/webhook', active: true },
      default_permissions: GITHUB_APP_MANIFEST_PERMISSIONS,
      default_events: [...GITHUB_APP_MANIFEST_EVENTS],
    });
    expect(started.body.manifest.default_permissions).toMatchObject({
      email_addresses: 'read',
    });

    const code = github.createAppFromManifest(started.body.manifest);
    const done = await post('/api/admin/platform-config/github-app/manifest/complete', admin, {
      code,
      state: started.body.state,
    });
    expect(done.status).toBe(200);
    const doneBody = (await done.json()) as { app: Record<string, unknown> };
    expect(doneBody.app).toEqual({
      slug: 'sam-example-com',
      htmlUrl: 'https://github.com/apps/sam-example-com',
      owner: 'octo',
      installUrl: 'https://github.com/apps/sam-example-com/installations/new',
    });
    // The response never carries the App's secrets.
    expect(JSON.stringify(doneBody)).not.toContain('PRIVATE KEY');
    expect(JSON.stringify(doneBody)).not.toContain('client-secret-0123456789abcdef');

    __resetPlatformConfigCacheForTest();
    const config = await resolvePlatformConfig(env);
    expect(config.github).toMatchObject({
      appId: { value: '123456' },
      appSlug: { value: 'sam-example-com' },
      clientId: { value: 'Iv23liExampleClient' },
      clientSecret: { value: 'client-secret-0123456789abcdef' },
      webhookSecret: { value: 'webhook-secret-0123456789abcdef' },
    });
    expect(config.github.appPrivateKey.value).toContain('PRIVATE KEY');
    expect((await getGitHubAppConfig(env))?.slug).toBe('sam-example-com');

    const after = await app.request(
      `${API}/api/github/install-url`,
      { headers: { cookie: admin } },
      env
    );
    expect(after.status).toBe(200);
    expect(await after.json()).toEqual({
      url: 'https://github.com/apps/sam-example-com/installations/new',
    });
  });

  it('uses the organization path when an organization is named', async () => {
    const started = await start(await cookieFor('admin'), { organization: 'acme-org' });
    expect(started.body.postUrl).toBe(
      `https://github.com/organizations/acme-org/settings/apps/new?state=${started.body.state}`
    );
  });

  it('refuses a state started by another administrator, and stores nothing', async () => {
    const started = await start(await cookieFor('admin'));
    const code = github.createAppFromManifest(started.body.manifest);
    const done = await post(
      '/api/admin/platform-config/github-app/manifest/complete',
      await cookieFor('other-admin'),
      { code, state: started.body.state }
    );
    expect(done.status).toBe(400);
    expect(await done.json()).toMatchObject({ error: 'GITHUB_APP_MANIFEST_STATE_INVALID' });
    expect(github.conversions).toEqual([]);
    __resetPlatformConfigCacheForTest();
    expect((await resolvePlatformConfig(env)).github.appId.value).toBeNull();
  });

  it('uses a state once', async () => {
    const admin = await cookieFor('admin');
    const started = await start(admin);
    const code = github.createAppFromManifest(started.body.manifest);
    const body = { code, state: started.body.state };
    expect(
      (await post('/api/admin/platform-config/github-app/manifest/complete', admin, body)).status
    ).toBe(200);
    const replay = await post(
      '/api/admin/platform-config/github-app/manifest/complete',
      admin,
      body
    );
    expect(replay.status).toBe(400);
    expect(github.conversions).toEqual([code]);
  });

  it('refuses non-superadmins at both steps', async () => {
    const member = await cookieFor('member');
    expect((await start(member)).response.status).toBe(403);
    const done = await post('/api/admin/platform-config/github-app/manifest/complete', member, {
      code: 'manifest-code-1',
      state: 'a'.repeat(64),
    });
    expect(done.status).toBe(403);
  });

  it('reports a code GitHub refuses as a clear error, without storing anything', async () => {
    const admin = await cookieFor('admin');
    const started = await start(admin);
    const done = await post('/api/admin/platform-config/github-app/manifest/complete', admin, {
      code: 'expired-code',
      state: started.body.state,
    });
    expect(done.status).toBe(502);
    expect(await done.json()).toMatchObject({ error: 'GITHUB_APP_MANIFEST_CONVERSION_FAILED' });
    __resetPlatformConfigCacheForTest();
    expect((await resolvePlatformConfig(env)).github.appId.value).toBeNull();
  });
});
