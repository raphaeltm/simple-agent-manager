/**
 * Owner security alerts go out through the same transport as sign-in codes
 * (`resolveSystemEmailTransport`). Box round R17 found every alert on a self-hosted box dropped
 * with `security_alert.no_sender`, because the alert asked only for Cloudflare's `AGENT_EMAIL`
 * binding while sign-in used SMTP. Entry points are the production ones: the Admin Settings
 * PATCH route (save and clear), and the account-link hook body BetterAuth calls. SMTP is a real
 * server on 127.0.0.1 reached through `cloudflare:sockets` (Node-backed in tests).
 */
import type Database from 'better-sqlite3';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../src/env';
import { __resetAdminSettingsCacheForTest } from '../../src/services/admin-settings';
import { emailSignInPlugins } from '../../src/services/email-sign-in';
import { scheduleAccountLinkedAlert } from '../../src/services/security-alerts';
import { createAdminSettingsEnv } from '../helpers/admin-settings-env';
import { type FakeSmtpServer, startFakeSmtpServer } from '../helpers/fake-smtp-server';

vi.mock('../../src/middleware/auth', () => ({
  getAuth: (c: any) => c.get('auth'),
  requireAuth: () => async (c: any, next: () => Promise<void>) => {
    c.set('auth', { user: { id: 'owner', status: 'active', role: 'superadmin' } });
    await next();
  },
  requireApproved: () => async (_c: any, next: () => Promise<void>) => next(),
  requireSuperadmin: () => async (_c: any, next: () => Promise<void>) => next(),
}));
const { adminSettingsRoutes } = await import('../../src/routes/admin-settings');

const FROM = 'alerts@box.example.com';
const OWNER = 'owner@example.com';
const app = new Hono<{ Bindings: Env }>().route('/settings', adminSettingsRoutes);

let sqlite: Database.Database;
let env: Env;
let smtp: FakeSmtpServer;

function smtpVars(port: number): Partial<Env> {
  return { SMTP_HOST: '127.0.0.1', SMTP_PORT: String(port), SMTP_TLS: 'none', SMTP_FROM: FROM };
}

function buildEnv(overrides: Partial<Env>): Env {
  const fixture = createAdminSettingsEnv({ BASE_DOMAIN: 'example.com', ...overrides });
  sqlite = fixture.sqlite;
  sqlite.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT, name TEXT, role TEXT, status TEXT);
    INSERT INTO users VALUES ('system_anonymous_trials', 'system@internal', 'System', 'superadmin', 'system');
    INSERT INTO users VALUES ('owner', '${OWNER}', 'Owner', 'superadmin', 'active');
  `);
  return fixture.env;
}

/** Sends a PATCH with a real `waitUntil` and waits for the background alert to finish. */
async function patch(changes: Array<{ name: string; value: unknown }>, expectedRevision: number) {
  const background: Promise<unknown>[] = [];
  const executionCtx = {
    waitUntil: (promise: Promise<unknown>) => background.push(promise),
    passThroughOnException: () => undefined,
    props: {},
  } as unknown as ExecutionContext;
  const response = await app.request(
    '/settings',
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expectedRevision, changes }),
    },
    env,
    executionCtx
  );
  await Promise.all(background);
  return response;
}

const SAVE = [
  { name: 'integration.google.clientId', value: 'stored-client-id' },
  { name: 'integration.google.clientSecret', value: 'stored-client-secret' },
];
const CLEAR = [
  { name: 'integration.google.clientId', value: null },
  { name: 'integration.google.clientSecret', value: null },
];

/** Every structured log line written while `run` executes, error and info alike. */
async function captureLogs(run: () => Promise<unknown>): Promise<string> {
  const lines: string[] = [];
  const record = (...args: unknown[]) => void lines.push(args.map(String).join(' '));
  const spies = [
    vi.spyOn(console, 'error').mockImplementation(record),
    vi.spyOn(console, 'warn').mockImplementation(record),
    vi.spyOn(console, 'log').mockImplementation(record),
    vi.spyOn(console, 'info').mockImplementation(record),
  ];
  try {
    await run();
    return lines.join('\n');
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
}

beforeEach(async () => {
  smtp = await startFakeSmtpServer({ mode: 'plain' });
  __resetAdminSettingsCacheForTest();
  // Google client validation answers "invalid_grant", which accepts the credentials as well-formed.
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ error: 'invalid_grant' })));
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  sqlite?.close();
  await smtp.close();
});

describe('owner security alerts over SMTP (self-hosted box, no AGENT_EMAIL)', () => {
  beforeEach(() => {
    env = buildEnv(smtpVars(smtp.port));
  });

  it('emails the owner from SMTP_FROM when an integration is saved and when it is cleared', async () => {
    let logs = await captureLogs(async () => expect((await patch(SAVE, 0)).status).toBe(200));
    expect(logs).not.toContain('security_alert.no_sender');
    expect(logs).toContain('"transport":"smtp"');
    expect(smtp.messages).toHaveLength(1);
    expect(smtp.messages[0]).toMatchObject({ from: FROM, to: [OWNER] });
    expect(smtp.messages[0]!.data).toContain(`From: "SAM security" <${FROM}>`);
    expect(smtp.messages[0]!.data).toContain(
      'Subject: SAM security alert: Google sign-in (OAuth) settings changed'
    );
    expect(smtp.messages[0]!.data).toContain('client id set');
    expect(smtp.messages[0]!.data).not.toContain('stored-client-secret');

    logs = await captureLogs(async () => expect((await patch(CLEAR, 1)).status).toBe(200));
    expect(logs).not.toContain('security_alert.no_sender');
    expect(smtp.messages).toHaveLength(2);
    expect(smtp.messages[1]!.data).toContain('client id cleared');
  });

  it('emails the owner when a sign-in is linked to a superadmin account', async () => {
    const background: Promise<unknown>[] = [];
    scheduleAccountLinkedAlert(
      env,
      { userId: 'owner', providerId: 'gitlab' },
      { waitUntil: (promise) => background.push(promise) }
    );
    await Promise.all(background);
    expect(smtp.messages).toHaveLength(1);
    expect(smtp.messages[0]!.data).toContain(
      'Subject: SAM security alert: a GitLab sign-in was linked to a superadmin account'
    );
  });

  it('uses the transport sign-in uses: both are on, or both are off, from one decision', async () => {
    // Liveness: sign-in is offered on this env, and the alert went out over the same SMTP.
    expect(emailSignInPlugins(env)).toHaveLength(1);
    await patch(SAVE, 0);
    expect(smtp.messages.map((message) => message.from)).toEqual([FROM]);
  });

  it('logs a failed send and still answers the admin change with 200', async () => {
    await smtp.close();
    const logs = await captureLogs(async () => expect((await patch(SAVE, 0)).status).toBe(200));
    expect(logs).toContain('security_alert.send_failed');
    expect(logs).not.toContain(OWNER);
  });
});

describe('owner security alerts through the Cloudflare binding (unchanged)', () => {
  it('sends from security@agents.<BASE_DOMAIN> through AGENT_EMAIL and never opens SMTP', async () => {
    const sent: Array<{ from: { email: string; name: string }; to: string; subject: string }> = [];
    env = buildEnv({
      // SMTP settings present too: the binding must still win, as it always has on Cloudflare.
      ...smtpVars(smtp.port),
      AGENT_EMAIL: {
        send: async (message: (typeof sent)[number]) => {
          sent.push(message);
          return { messageId: 'm' };
        },
      } as unknown as SendEmail,
    });
    expect((await patch(SAVE, 0)).status).toBe(200);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      from: { email: 'security@agents.example.com', name: 'SAM security' },
      to: OWNER,
      subject: 'SAM security alert: Google sign-in (OAuth) settings changed',
    });
    expect(smtp.messages).toHaveLength(0);
    expect(smtp.commands).toHaveLength(0);
  });
});

describe('owner security alerts with no transport configured', () => {
  it('logs security_alert.no_sender, sends nothing, and the admin change still succeeds', async () => {
    env = buildEnv({});
    const logs = await captureLogs(async () => expect((await patch(SAVE, 0)).status).toBe(200));
    expect(logs).toContain('security_alert.no_sender');
    expect(smtp.messages).toHaveLength(0);
    // Liveness: the change itself was stored.
    const row = sqlite
      .prepare(`SELECT COUNT(*) AS n FROM platform_settings WHERE key LIKE '%google%'`)
      .get() as { n: number } | undefined;
    expect(row?.n ?? 0).toBeGreaterThan(0);
  });
});
