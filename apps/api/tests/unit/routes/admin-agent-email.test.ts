/**
 * Superadmin agent email status and loopback test through the real route, the real auth
 * gates, a real SQLite database and an in-memory KV. Only the session lookup is pre-set:
 * `requireAuth` skips it when the request already carries an auth context.
 */
import { readFileSync } from 'node:fs';

import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { handleAppError } from '../../../src/middleware/app-error-handler';
import { adminAgentEmailRoutes } from '../../../src/routes/admin-agent-email';
import { updateAdminSettings } from '../../../src/services/admin-settings';
import { LOOPBACK_SUBJECT } from '../../../src/services/agent-email/loopback';
import { createAllSchemaTables, createMemoryKv, createSqliteD1 } from '../../helpers/sqlite-d1';

const BASE_DOMAIN = 'fixture.example';
const ADDRESS_ID = 'k3j2h7m9q2xw4n8p';
const ADDRESS = `agent+${ADDRESS_ID}@agents.${BASE_DOMAIN}`;
const LOOPBACK = `agent+loopback@agents.${BASE_DOMAIN}`;

type Role = 'superadmin' | 'admin' | 'user';

describe('admin agent email routes', () => {
  let sqlite: Database.Database;
  let send: ReturnType<typeof vi.fn>;
  let env: Env;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    createAllSchemaTables(sqlite, schema);
    sqlite.exec(
      readFileSync(
        new URL('../../../src/db/migrations/0196_admin_settings.sql', import.meta.url),
        'utf8'
      )
    );
    const now = new Date().toISOString();
    sqlite
      .prepare(
        `INSERT INTO users (id, email, name, role, status) VALUES ('user-1', 'owner@example.com', 'Owner', 'user', 'active')`
      )
      .run();
    sqlite
      .prepare(
        `INSERT INTO projects (id, user_id, name) VALUES ('project-1', 'user-1', 'Payments')`
      )
      .run();
    sqlite
      .prepare(
        `INSERT INTO triggers
          (id, project_id, user_id, name, status, source_type, skip_if_running, prompt_template,
           task_mode, max_concurrent, trigger_count, next_execution_sequence, created_at, updated_at)
         VALUES ('trigger-1', 'project-1', 'user-1', 'Support inbox', 'active', 'email', 0,
                 '{{email.text}}', 'task', 1, 0, 1, ?, ?)`
      )
      .run(now, now);
    sqlite
      .prepare(
        `INSERT INTO trigger_email_configs (trigger_id, address_key, allowed_senders_json)
         VALUES ('trigger-1', ?, ?)`
      )
      .run(ADDRESS_ID, JSON.stringify([LOOPBACK]));
    send = vi.fn(async () => ({ messageId: 'provider-message-1' }));
    env = {
      DATABASE: createSqliteD1(sqlite),
      KV: createMemoryKv(),
      BASE_DOMAIN,
      AGENT_EMAIL: { send } as unknown as SendEmail,
    } as Env;
  });

  afterEach(() => sqlite.close());

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

  function sendLoopback(app: Hono<{ Bindings: Env }>, to: string, bindings: Env = env) {
    return app.request(
      '/api/admin/agent-email/loopback',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to }),
      },
      bindings
    );
  }

  it('lets only a superadmin read the status or send the loopback test', async () => {
    for (const role of ['admin', 'user'] as const) {
      const app = appAs(role);
      expect((await app.request('/api/admin/agent-email', {}, env)).status).toBe(403);
      expect((await sendLoopback(app, ADDRESS)).status).toBe(403);
    }
    expect(send).not.toHaveBeenCalled();

    const status = await appAs('superadmin').request('/api/admin/agent-email', {}, env);
    expect(status.status).toBe(200);
    expect(await status.json()).toEqual({
      enabled: true,
      domain: `agents.${BASE_DOMAIN}`,
      loopback: { lastSent: null, lastReceived: null },
    });
  });

  it('sends the fixed message only to an existing email trigger on this deployment', async () => {
    const app = appAs('superadmin');
    for (const [to, status] of [
      ['someone@example.com', 400],
      [LOOPBACK, 400],
      [`agent+${ADDRESS_ID}@agents.other.example`, 400],
      ['agent+zzzzzzzzzzzzzzzz@agents.fixture.example', 404],
    ] as const) {
      expect((await sendLoopback(app, to)).status, to).toBe(status);
    }
    expect(send).not.toHaveBeenCalled();

    const response = await sendLoopback(app, ADDRESS.toUpperCase());
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({
      to: ADDRESS,
      providerMessageId: 'provider-message-1',
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        from: { email: LOOPBACK, name: 'SAM loopback test' },
        to: ADDRESS,
        subject: expect.stringMatching(new RegExp(`^${LOOPBACK_SUBJECT} `)),
      })
    );

    const status = await (await app.request('/api/admin/agent-email', {}, env)).json();
    expect(status).toMatchObject({ loopback: { lastSent: { to: ADDRESS }, lastReceived: null } });
  });

  it('bounds loopback sends per superadmin per hour', async () => {
    await updateAdminSettings(env, {
      changes: [{ name: 'agentEmail.loopbackPerHour', value: 2 }],
      actorUserId: 'superadmin-1',
    });
    const app = appAs('superadmin');

    expect((await sendLoopback(app, ADDRESS)).status).toBe(202);
    expect((await sendLoopback(app, ADDRESS)).status).toBe(202);
    expect((await sendLoopback(app, ADDRESS)).status).toBe(429);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('reports agent email as off, and refuses the test, without the binding', async () => {
    const withoutBinding = { ...env, AGENT_EMAIL: undefined } as Env;
    const app = appAs('superadmin');

    const status = await app.request('/api/admin/agent-email', {}, withoutBinding);
    expect(await status.json()).toMatchObject({ enabled: false, domain: null });
    expect((await sendLoopback(app, ADDRESS, withoutBinding)).status).toBe(409);
    expect(send).not.toHaveBeenCalled();
  });
});
