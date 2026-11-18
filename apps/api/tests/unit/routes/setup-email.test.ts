/**
 * First-run setup on a deployment that can send email: setup completes with email sign-in
 * alone. Setup is only about getting to a running SAM, so it never touches agent email (that
 * stays an admin choice). Real SQLite, a fake Cloudflare zone (`fakeCloudflareEmail`) to
 * observe that nothing calls it, the production setup routes.
 */
import { readFileSync } from 'node:fs';

import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { handleAppError } from '../../../src/middleware/app-error-handler';
import { setupRoutes } from '../../../src/routes/setup';
import { isAgentEmailOn } from '../../../src/services/agent-email/setup-state';
import { __resetPlatformConfigCacheForTest } from '../../../src/services/platform-config';
import { FAKE_CF_ZONE_ID, fakeCloudflareEmail } from '../../helpers/fake-cloudflare-email';
import { createAllSchemaTables, createMemoryKv, createSqliteD1 } from '../../helpers/sqlite-d1';

const MAIN = 'fixture.example';
const DOMAIN = `agents.${MAIN}`;

interface VerifyBody {
  signIn: { email: boolean; ownerEmail: string | null };
}

interface CompleteBody {
  completed: boolean;
}

function createApp() {
  const app = new Hono<{ Bindings: Env }>();
  app.onError(handleAppError);
  app.route('/api/setup', setupRoutes);
  return app;
}

describe('first-run setup with email', () => {
  let sqlite: Database.Database;
  let env: Env;
  let ip = 0;
  const app = createApp();

  function makeEnv(overrides: Partial<Env> = {}): Env {
    return {
      DATABASE: createSqliteD1(sqlite),
      KV: createMemoryKv(),
      BASE_DOMAIN: MAIN,
      ENCRYPTION_KEY: 'test-encryption-key',
      SETUP_TOKEN: 'setup-token',
      BOOTSTRAP_OWNER_EMAIL: 'owner@fixture.example',
      CF_ZONE_ID: FAKE_CF_ZONE_ID,
      CF_API_TOKEN: 'cf-token',
      AGENT_EMAIL: { send: vi.fn() } as unknown as SendEmail,
      AGENT_EMAIL_WORKER_NAME: 'sam-api-fixture',
      ...overrides,
    } as Env;
  }

  beforeEach(() => {
    sqlite = new Database(':memory:');
    createAllSchemaTables(sqlite, schema);
    // Setup writes go through the admin settings revision/audit tables this migration adds.
    sqlite.exec(
      readFileSync(
        new URL('../../../src/db/migrations/0196_admin_settings.sql', import.meta.url),
        'utf8'
      )
    );
    sqlite
      .prepare(
        `INSERT INTO users (id, email, email_verified, name, role, status, created_at, updated_at)
         VALUES ('system_anonymous_trials', 'system@internal', 0, 'System', 'user', 'system', 0, 0)`
      )
      .run();
    env = makeEnv();
    __resetPlatformConfigCacheForTest();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    sqlite.close();
  });

  /** A zone that has never used Email Routing; Email Sending already verified by the deploy. */
  function newZone() {
    const fake = fakeCloudflareEmail({
      zoneName: MAIN,
      dns: [{ type: 'A', name: MAIN, content: '192.0.2.10' }],
      sending: [{ name: DOMAIN, enabled: true }],
    });
    vi.stubGlobal('fetch', fake.fetchMock);
    return fake;
  }

  async function post(path: string, body: unknown) {
    ip += 1;
    return app.request(
      `/api/setup${path}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': `198.51.100.${ip}` },
        body: JSON.stringify(body),
      },
      env
    );
  }

  it('reports email sign-in and the owner after the token is verified', async () => {
    const fake = newZone();
    const res = await post('/verify', { token: 'setup-token' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as VerifyBody & Record<string, unknown>;
    expect(body.signIn).toEqual({
      email: true,
      emailReady: true,
      ownerEmail: 'owner@fixture.example',
    });
    expect(body).not.toHaveProperty('agentEmail');
    // Only reads: whether Cloudflare has verified the sending domain.
    expect(fake.writes()).toEqual([]);
  });

  it('completes with email sign-in alone and leaves agent email to the admin', async () => {
    const fake = newZone();
    const res = await post('/complete', {
      token: 'setup-token',
      config: {},
      // An older client may still send this; setup ignores it.
      agentEmail: { consentToken: 'anything' },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as CompleteBody & Record<string, unknown>;
    expect(body.completed).toBe(true);
    expect(body).not.toHaveProperty('agentEmail');
    await expect(isAgentEmailOn(env)).resolves.toBe(false);
    expect(fake.writes()).toEqual([]);
  });

  it('waits for Cloudflare to verify the sending domain before closing setup on email alone', async () => {
    const fake = fakeCloudflareEmail({
      zoneName: MAIN,
      dns: [{ type: 'A', name: MAIN, content: '192.0.2.10' }],
      sending: [{ name: DOMAIN, enabled: false }],
    });
    vi.stubGlobal('fetch', fake.fetchMock);
    const verify = (await (await post('/verify', { token: 'setup-token' })).json()) as {
      signIn: Record<string, unknown>;
    };
    expect(verify.signIn).toMatchObject({ email: true, emailReady: false });
    // Closing setup now would leave no way in: no code can be sent, and no OAuth provider.
    const res = await post('/complete', { token: 'setup-token', config: {} });
    expect(res.status).toBe(400);
    // Control: once verified, the same request completes.
    fake.state.sending[0]!.enabled = true;
    expect((await post('/complete', { token: 'setup-token', config: {} })).status).toBe(200);
  });

  it('does not block setup when the sending state cannot be read', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ success: false }), { status: 403 }))
    );
    const verify = (await (await post('/verify', { token: 'setup-token' })).json()) as {
      signIn: Record<string, unknown>;
    };
    expect(verify.signIn).toMatchObject({ email: true, emailReady: true });
    expect((await post('/complete', { token: 'setup-token', config: {} })).status).toBe(200);
  });

  it('still needs a sign-in provider where the deployment cannot send email', async () => {
    env = makeEnv({ AGENT_EMAIL: undefined, AGENT_EMAIL_WORKER_NAME: undefined });
    const verify = (await (await post('/verify', { token: 'setup-token' })).json()) as VerifyBody;
    expect(verify.signIn.email).toBe(false);

    const res = await post('/complete', { token: 'setup-token', config: {} });
    expect(res.status).toBe(400);
  });
});
