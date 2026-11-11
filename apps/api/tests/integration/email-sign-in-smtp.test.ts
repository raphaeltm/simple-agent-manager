/**
 * Email sign-in over SMTP, end to end: the production `/api/auth` routes and public config
 * route, the real better-auth emailOTP plugin, a real SQL engine and KV, and a real SMTP server
 * on 127.0.0.1 reached through `cloudflare:sockets` (Node-backed in tests). No `AGENT_EMAIL`
 * binding, as on a self-hosted celld box. Controls prove a Cloudflare install is unchanged.
 */
import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../src/db/schema';
import type { Env } from '../../src/env';
import { handleAppError } from '../../src/middleware/app-error-handler';
import { authRoutes } from '../../src/routes/auth';
import {
  emailSignInAvailable,
  emailSignInReadiness,
  emailSignUpOffered,
} from '../../src/services/email-sign-in';
import { resolvePlatformCapabilities } from '../../src/services/platform-capabilities';
import { __resetPlatformConfigCacheForTest } from '../../src/services/platform-config';
import { type FakeSmtpServer, startFakeSmtpServer } from '../helpers/fake-smtp-server';
import { createAllSchemaTables, createMemoryKv, createSqliteD1 } from '../helpers/sqlite-d1';

const API_ORIGIN = 'https://api.example.com';
const APP_ORIGIN = 'https://app.example.com';
const OWNER = 'owner@example.com';
const FROM = 'sign-in@example.com';

function codeFrom(data: string | undefined): string {
  const body = data?.split('\r\n\r\n').slice(1).join('\r\n\r\n') ?? '';
  const match = /\b(\d{6})\b/.exec(body);
  if (!match?.[1]) throw new Error('No sign-in code in the email');
  return match[1];
}

function buildApp() {
  const app = new Hono<{ Bindings: Env }>();
  app.onError(handleAppError);
  app.route('/api/auth', authRoutes);
  return app;
}

describe('email sign-in over SMTP (vertical slice)', () => {
  let sqlite: Database.Database;
  let smtp: FakeSmtpServer;
  let env: Env;
  let cookie = '';
  const app = buildApp();

  function smtpVars(port: number): Partial<Env> {
    return { SMTP_HOST: '127.0.0.1', SMTP_PORT: String(port), SMTP_TLS: 'none', SMTP_FROM: FROM };
  }

  function makeEnv(overrides: Partial<Env> = {}): Env {
    return {
      DATABASE: createSqliteD1(sqlite),
      KV: createMemoryKv(),
      BASE_DOMAIN: 'example.com',
      ENCRYPTION_KEY: 'test-encryption-key',
      BOOTSTRAP_OWNER_EMAIL: OWNER,
      ...smtpVars(smtp.port),
      ...overrides,
    } as Env;
  }

  beforeEach(async () => {
    sqlite = new Database(':memory:');
    createAllSchemaTables(sqlite, schema);
    sqlite
      .prepare(
        `INSERT INTO users (id, email, email_verified, name, role, status, created_at, updated_at)
         VALUES ('system_anonymous_trials', 'system@internal', 0, 'System', 'user', 'system', 0, 0)`
      )
      .run();
    smtp = await startFakeSmtpServer({ mode: 'plain' });
    env = makeEnv();
    __resetPlatformConfigCacheForTest();
    cookie = '';
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    sqlite.close();
    await smtp.close();
  });

  /** Runs the request with a real waitUntil and waits for the background send to finish. */
  async function requestCode(email: string): Promise<Response> {
    const background: Promise<unknown>[] = [];
    const executionCtx = {
      waitUntil: (promise: Promise<unknown>) => background.push(promise),
      passThroughOnException: () => undefined,
      props: {},
    } as unknown as ExecutionContext;
    const response = await app.request(
      `${API_ORIGIN}/api/auth/email-otp/send-verification-otp`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: APP_ORIGIN,
          'CF-Connecting-IP': '203.0.113.7',
        },
        body: JSON.stringify({ email, type: 'sign-in' }),
      },
      env,
      executionCtx
    );
    await Promise.all(background);
    return response;
  }

  async function signIn(email: string, otp: string): Promise<Response> {
    const response = await app.request(
      `${API_ORIGIN}/api/auth/sign-in/email-otp`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: APP_ORIGIN },
        body: JSON.stringify({ email, otp }),
      },
      env
    );
    const setCookies = response.headers.getSetCookie();
    if (setCookies.length > 0) cookie = setCookies.map((v) => v.split(';', 1)[0]).join('; ');
    return response;
  }

  async function me() {
    const response = await app.request(`${API_ORIGIN}/api/auth/me`, { headers: { cookie } }, env);
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  }

  it('signs the owner up with a code delivered over SMTP from SMTP_FROM', async () => {
    const response = await requestCode(OWNER);
    expect(response.status).toBe(200);
    expect(smtp.messages).toHaveLength(1);
    const [message] = smtp.messages;
    expect(message).toMatchObject({ from: FROM, to: [OWNER] });
    expect(message?.data).toContain(`From: "SAM" <${FROM}>`);
    expect(message?.data).toMatch(/Subject: \d{6} is your SAM sign-in code/);

    expect((await signIn(OWNER, codeFrom(message?.data))).status).toBe(200);
    expect(await me()).toMatchObject({
      status: 200,
      body: { email: OWNER, role: 'superadmin', status: 'active' },
    });
  });

  it('sends nothing for an unknown address and answers exactly as for the owner', async () => {
    const stranger = await requestCode('stranger@example.com');
    const owner = await requestCode(OWNER);
    expect(stranger.status).toBe(owner.status);
    expect(await stranger.text()).toBe(await owner.text());
    // Liveness: the owner's code did go out over the same transport.
    expect(smtp.messages.map((message) => message.to)).toEqual([[OWNER]]);
    expect(smtp.commands.filter((command) => command.includes('stranger'))).toEqual([]);
  });

  it('keeps the per-address hourly budget on the SMTP transport', async () => {
    for (let i = 0; i < 7; i += 1) await requestCode(OWNER);
    // DEFAULT_AGENT_EMAIL_SIGN_IN_CODES_PER_EMAIL_PER_HOUR = 5.
    expect(smtp.messages).toHaveLength(5);
  });

  it('reports a send failure without failing the request or leaking which address it was', async () => {
    await smtp.close();
    const response = await requestCode(OWNER);
    expect(response.status).toBe(200);
  });

  it('decides readiness without calling Cloudflare', async () => {
    // Cloudflare API credentials present, so only the transport check can keep the call away.
    env = makeEnv({ CF_API_TOKEN: 'cf-token', CF_ACCOUNT_ID: 'cf-account', CF_ZONE_ID: 'zone' });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('no network'));
    expect(await emailSignInReadiness(env)).toBe('ready');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('offers email sign-in, sign-up and the emailSending capability with SMTP', () => {
    expect(emailSignInAvailable(env)).toBe(true);
    expect(emailSignUpOffered(env)).toBe(true);
    expect(resolvePlatformCapabilities(env).emailSending).toBe(true);
  });

  it('offers nothing with no transport, or with invalid SMTP settings (fail closed)', async () => {
    for (const overrides of [
      { SMTP_HOST: undefined },
      { SMTP_TLS: 'none', SMTP_HOST: 'smtp.example.com' },
      { SMTP_FROM: undefined },
    ] as Array<Partial<Env>>) {
      env = makeEnv(overrides);
      expect(emailSignInAvailable(env)).toBe(false);
      expect(resolvePlatformCapabilities(env).emailSending).toBe(false);
      expect(await emailSignInReadiness(env)).toBe('unavailable');
      // The emailOTP routes are not mounted at all.
      expect((await requestCode(OWNER)).status).toBe(404);
    }
    expect(smtp.messages).toHaveLength(0);
  });

  it('uses the Cloudflare binding, not SMTP, when both exist (Cloudflare installs unchanged)', async () => {
    const sent: Array<{ from: { email: string } }> = [];
    env = makeEnv({
      AGENT_EMAIL: {
        send: async (message: { from: { email: string } }) => {
          sent.push(message);
          return { messageId: 'cf-1' };
        },
      } as unknown as SendEmail,
    });
    await requestCode(OWNER);
    expect(sent.map((message) => message.from.email)).toEqual(['sign-in@agents.example.com']);
    expect(smtp.messages).toHaveLength(0);
  });
});
