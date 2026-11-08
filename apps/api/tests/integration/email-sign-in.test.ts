/**
 * Email sign-in, end to end: the production `/api/auth` routes, the real better-auth emailOTP
 * plugin, a real SQL engine and KV, and a fake `AGENT_EMAIL` send binding that records what
 * would have been mailed. See `src/services/email-sign-in.ts`.
 */
import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import * as schema from '../../src/db/schema';
import type { Env } from '../../src/env';
import { handleAppError } from '../../src/middleware/app-error-handler';
import { authRoutes } from '../../src/routes/auth';
import { __resetPlatformConfigCacheForTest } from '../../src/services/platform-config';
import { createAllSchemaTables, createMemoryKv, createSqliteD1 } from '../helpers/sqlite-d1';

const API_ORIGIN = 'https://api.example.com';
const APP_ORIGIN = 'https://app.example.com';
const OWNER = 'owner@example.com';

interface SentEmail {
  from: { email: string; name: string };
  to: string;
  subject: string;
  text: string;
}

function createFakeSendBinding() {
  const sent: SentEmail[] = [];
  const binding = {
    async send(message: SentEmail) {
      sent.push(message);
      return { messageId: `message-${sent.length}` };
    },
  };
  return { sent, binding: binding as unknown as SendEmail };
}

function codeFrom(email: SentEmail | undefined): string {
  const match = /\b(\d{6})\b/.exec(email?.text ?? '');
  if (!match?.[1]) throw new Error('No sign-in code in the email');
  return match[1];
}

function buildApp() {
  // Mounted, and its errors handled, exactly as `src/index.ts` does.
  const app = new Hono<{ Bindings: Env }>();
  app.onError(handleAppError);
  app.route('/api/auth', authRoutes);
  return app;
}

describe('email sign-in through better-auth (vertical slice)', () => {
  let sqlite: Database.Database;
  let env: Env;
  let mail: ReturnType<typeof createFakeSendBinding>;
  let cookie = '';
  const app = buildApp();

  function makeEnv(overrides: Partial<Env> = {}): Env {
    return {
      DATABASE: createSqliteD1(sqlite),
      KV: createMemoryKv(),
      BASE_DOMAIN: 'example.com',
      ENCRYPTION_KEY: 'test-encryption-key',
      AGENT_EMAIL: mail.binding,
      ...overrides,
    } as Env;
  }

  beforeEach(() => {
    sqlite = new Database(':memory:');
    createAllSchemaTables(sqlite, schema);
    // The migration-seeded sentinel user (0043) that "first user" checks must ignore.
    sqlite
      .prepare(
        `INSERT INTO users (id, email, email_verified, name, role, status, created_at, updated_at)
         VALUES ('system_anonymous_trials', 'system@internal', 0, 'System', 'user', 'system', 0, 0)`
      )
      .run();
    mail = createFakeSendBinding();
    env = makeEnv({ BOOTSTRAP_OWNER_EMAIL: OWNER });
    __resetPlatformConfigCacheForTest();
    cookie = '';
  });

  afterEach(() => {
    sqlite.close();
  });

  async function requestCode(email: string, ip = '203.0.113.7'): Promise<Response> {
    return app.request(
      `${API_ORIGIN}/api/auth/email-otp/send-verification-otp`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: APP_ORIGIN,
          'CF-Connecting-IP': ip,
        },
        body: JSON.stringify({ email, type: 'sign-in' }),
      },
      env
    );
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
    if (setCookies.length > 0) {
      cookie = setCookies.map((value) => value.split(';', 1)[0]).join('; ');
    }
    return response;
  }

  async function me() {
    const response = await app.request(`${API_ORIGIN}/api/auth/me`, { headers: { cookie } }, env);
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  }

  function realUsers() {
    return sqlite
      .prepare(`SELECT id, email, role, status FROM users WHERE status != 'system' ORDER BY id`)
      .all() as Array<{ id: string; email: string; role: string; status: string }>;
  }

  it('signs the installer owner up with an emailed code and makes them the administrator', async () => {
    const sendResponse = await requestCode(OWNER);
    expect(sendResponse.status).toBe(200);
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0]).toMatchObject({
      to: OWNER,
      from: { email: 'sign-in@agents.example.com', name: 'SAM' },
    });
    expect(mail.sent[0]?.subject).toContain(codeFrom(mail.sent[0]));

    const response = await signIn(OWNER, codeFrom(mail.sent[0]));
    expect(response.status).toBe(200);

    const current = await me();
    expect(current.status).toBe(200);
    expect(current.body).toMatchObject({
      email: OWNER,
      name: 'owner',
      role: 'superadmin',
      status: 'active',
    });
    expect(realUsers()).toHaveLength(1);
  });

  it('sends no code to anyone else before the owner exists, and creates no account', async () => {
    const response = await requestCode('stranger@example.com');
    // Same answer as for an address that gets a code, so the form reveals nothing.
    expect(response.status).toBe(200);
    expect(mail.sent).toHaveLength(0);
    expect((await signIn('stranger@example.com', '000000')).status).toBe(400);
    expect(realUsers()).toHaveLength(0);

    // Liveness control: the owner still gets one.
    await requestCode(OWNER);
    expect(mail.sent.map((sent) => sent.to)).toEqual([OWNER]);
  });

  it('sends codes only to existing accounts once the owner exists', async () => {
    await requestCode(OWNER);
    await signIn(OWNER, codeFrom(mail.sent[0]));

    await requestCode('newcomer@example.com');
    expect(mail.sent.map((sent) => sent.to)).toEqual([OWNER]);

    // An existing account made another way (GitHub) can use email from now on.
    sqlite
      .prepare(
        `INSERT INTO users (id, email, email_verified, name, role, status, created_at, updated_at)
         VALUES ('github-user', 'teammate@example.com', 1, 'Teammate', 'user', 'active', 1, 1)`
      )
      .run();
    await requestCode('teammate@example.com');
    expect(mail.sent.map((sent) => sent.to)).toEqual([OWNER, 'teammate@example.com']);
    cookie = '';
    expect((await signIn('teammate@example.com', codeFrom(mail.sent[1]))).status).toBe(200);
    expect((await me()).body).toMatchObject({ id: 'github-user', role: 'user' });
    expect(realUsers()).toHaveLength(2);
  });

  it('lets the first person sign up on an install without an owner email', async () => {
    // With approval on, the user-create hook itself makes the first person superadmin. (With it
    // off, the login self-heal does that through numbered SQL params, which the better-sqlite3
    // D1 shim cannot bind.)
    env = makeEnv({ REQUIRE_APPROVAL: 'true' });
    await requestCode('first@example.com');
    expect(mail.sent).toHaveLength(1);
    expect((await signIn('first@example.com', codeFrom(mail.sent[0]))).status).toBe(200);
    expect((await me()).body).toMatchObject({ email: 'first@example.com', role: 'superadmin' });

    // The second person does not get a code: email sign-up is for the first user only.
    await requestCode('second@example.com');
    expect(mail.sent).toHaveLength(1);
  });

  it('rejects a wrong code', async () => {
    await requestCode(OWNER);
    const wrong = codeFrom(mail.sent[0]) === '123456' ? '654321' : '123456';
    expect((await signIn(OWNER, wrong)).status).toBe(400);
    expect(realUsers()).toHaveLength(0);
  });

  it('stops emailing one address after its hourly budget', async () => {
    for (let attempt = 0; attempt < 7; attempt += 1) {
      expect((await requestCode(OWNER, `198.51.100.${attempt}`)).status).toBe(200);
    }
    expect(mail.sent).toHaveLength(5);
  });

  it('limits code requests per IP address', async () => {
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 21; attempt += 1) {
      statuses.push((await requestCode(`person${attempt}@example.com`)).status);
    }
    expect(statuses.slice(0, 20).every((status) => status === 200)).toBe(true);
    expect(statuses[20]).toBe(429);
  });

  it('offers no email sign-in where the deployment cannot send email', async () => {
    env = makeEnv({ BOOTSTRAP_OWNER_EMAIL: OWNER, AGENT_EMAIL: undefined });
    const response = await requestCode(OWNER);
    expect(response.status).toBe(404);
    expect(mail.sent).toHaveLength(0);
  });
});
