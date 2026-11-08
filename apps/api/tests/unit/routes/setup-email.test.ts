/**
 * First-run setup on a deployment that can send email: setup completes with email sign-in
 * alone, and turns agent email on with the plan the owner previewed. Real SQLite, a fake
 * Cloudflare zone (`fakeCloudflareEmail`), the production setup routes.
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
  agentEmail: { state: string; consentToken: string | null; domain: string | null } | null;
}

interface CompleteBody {
  completed: boolean;
  agentEmail: { plan: { state: string } | null; error: string | null } | null;
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

  it('reports email sign-in, the owner and the agent email plan after the token is verified', async () => {
    newZone();
    const res = await post('/verify', { token: 'setup-token' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as VerifyBody;
    expect(body.signIn).toEqual({ email: true, ownerEmail: 'owner@fixture.example' });
    expect(body.agentEmail).toMatchObject({ state: 'needs_consent', domain: DOMAIN });
    expect(body.agentEmail?.consentToken).toBeTruthy();
  });

  it('completes with email sign-in alone and turns agent email on with the previewed plan', async () => {
    newZone();
    const verify = (await (await post('/verify', { token: 'setup-token' })).json()) as VerifyBody;

    const res = await post('/complete', {
      token: 'setup-token',
      config: {},
      agentEmail: { consentToken: verify.agentEmail?.consentToken },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as CompleteBody;
    expect(body.completed).toBe(true);
    expect(body.agentEmail?.error).toBeNull();
    expect(body.agentEmail?.plan?.state).toBe('on');
    await expect(isAgentEmailOn(env)).resolves.toBe(true);
  });

  it('leaves agent email off when the owner turns it off', async () => {
    const fake = newZone();
    const res = await post('/complete', { token: 'setup-token', config: {} });
    expect(res.status).toBe(200);
    expect(((await res.json()) as CompleteBody).agentEmail).toBeNull();
    await expect(isAgentEmailOn(env)).resolves.toBe(false);
    expect(fake.calls.filter((call) => call.method !== 'GET')).toEqual([]);
  });

  it('still completes setup, and reports why, when agent email cannot turn on', async () => {
    newZone();
    const res = await post('/complete', {
      token: 'setup-token',
      config: {},
      agentEmail: { consentToken: 'not-the-plan-token' },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as CompleteBody;
    expect(body.completed).toBe(true);
    expect(body.agentEmail?.plan).toBeNull();
    expect(body.agentEmail?.error).toMatch(/different from what you allowed/);
    await expect(isAgentEmailOn(env)).resolves.toBe(false);
  });

  it('still needs a sign-in provider where the deployment cannot send email', async () => {
    env = makeEnv({ AGENT_EMAIL: undefined, AGENT_EMAIL_WORKER_NAME: undefined });
    const verify = (await (await post('/verify', { token: 'setup-token' })).json()) as VerifyBody;
    expect(verify.signIn.email).toBe(false);
    expect(verify.agentEmail?.state).toBe('unavailable');

    const res = await post('/complete', { token: 'setup-token', config: {} });
    expect(res.status).toBe(400);
  });
});
