/**
 * Email trigger management through the real trigger routes and a real SQLite database.
 * Only authentication, project authorization and attribution health are stubbed.
 */
import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { handleAppError } from '../../../src/middleware/app-error-handler';
import { updateAdminSettings } from '../../../src/services/admin-settings';
import { markAgentEmailSetUp } from '../../helpers/agent-email-tables';
import { createAllSchemaTables, createMemoryKv, createSqliteD1 } from '../../helpers/sqlite-d1';

vi.mock('../../../src/middleware/auth', () => ({
  requireAuth: () =>
    vi.fn((c: { set: (key: string, value: unknown) => void }, next: () => Promise<void>) => {
      c.set('auth', { user: { id: 'user-1', name: 'Owner', email: 'Owner@Example.com' } });
      return next();
    }),
  requireApproved: () => vi.fn((_c: unknown, next: () => Promise<void>) => next()),
  getAuth: (c: { get: (key: string) => unknown }) => c.get('auth'),
  getUserId: () => 'user-1',
}));

vi.mock('../../../src/middleware/project-auth', () => ({
  requireProjectCapability: vi.fn().mockResolvedValue({
    id: 'project-1',
    userId: 'user-1',
    name: 'Payments API',
    repository: 'acme/payments',
    maxTriggers: null,
  }),
}));

vi.mock('../../../src/services/project-multiplayer', () => ({
  getProjectMultiplayerState: vi.fn().mockResolvedValue({
    activeMemberCount: 1,
    hasActiveInviteLink: false,
    hasPendingAccessRequest: false,
    multiplayerActive: false,
  }),
  clearProjectMultiplayerStateCache: vi.fn(),
}));

vi.mock('../../../src/services/credential-attribution-health', () => ({
  buildCredentialAttributionForTriggers: vi.fn().mockResolvedValue(new Map()),
  clearCredentialAttributionHealthCache: vi.fn(),
}));

const { triggersRoutes } = await import('../../../src/routes/triggers');

const ADDRESS_PATTERN = /^agent\+[0-9a-hjkmnp-tv-z]{16}@agents\.fixture\.example$/;

describe('email trigger routes', () => {
  let sqlite: Database.Database;
  let env: Env;
  let app: Hono<{ Bindings: Env }>;

  beforeEach(async () => {
    sqlite = new Database(':memory:');
    createAllSchemaTables(sqlite, schema);
    sqlite.exec(
      // The admin settings revision/audit tables come from a migration, not the schema.
      `CREATE TABLE admin_settings_revision (singleton INTEGER PRIMARY KEY, revision INTEGER NOT NULL DEFAULT 0, mutation_id TEXT NOT NULL DEFAULT '');
       INSERT INTO admin_settings_revision(singleton) VALUES (1);
       CREATE TABLE admin_settings_audit (id TEXT PRIMARY KEY, name TEXT NOT NULL, action TEXT NOT NULL, actor_user_id TEXT NOT NULL, created_at TEXT NOT NULL, revision INTEGER NOT NULL);`
    );
    sqlite
      .prepare(
        `INSERT INTO users (id, email, name, role, status) VALUES ('user-1', ?, 'Owner', 'user', 'active')`
      )
      .run('Owner@Example.com');
    sqlite
      .prepare(
        `INSERT INTO projects (id, user_id, name) VALUES ('project-1', 'user-1', 'Payments API')`
      )
      .run();
    sqlite
      .prepare(
        `INSERT INTO agent_profiles (id, project_id, user_id, name, created_at, updated_at)
         VALUES ('profile-1', 'project-1', 'user-1', 'Support agent', ?, ?)`
      )
      .run(new Date().toISOString(), new Date().toISOString());
    env = {
      DATABASE: createSqliteD1(sqlite),
      KV: createMemoryKv(),
      BASE_DOMAIN: 'fixture.example',
      AGENT_EMAIL: { send: vi.fn() } as unknown as SendEmail,
      ENCRYPTION_KEY: 'agent-email-route-test-key-0123456789',
    } as Env;
    app = new Hono<{ Bindings: Env }>();
    app.onError(handleAppError);
    app.route('/api/projects/:projectId/triggers', triggersRoutes);
    await markAgentEmailSetUp(env);
  });

  afterEach(() => sqlite.close());

  function call(method: string, path: string, body?: unknown, bindings: Env = env) {
    return app.request(
      `/api/projects/project-1/triggers${path}`,
      {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      },
      bindings
    );
  }

  const emailTrigger = (overrides: Record<string, unknown> = {}) => ({
    name: 'Support inbox',
    sourceType: 'email',
    promptTemplate: 'Email from {{email.from}}: {{email.text}}',
    agentProfileId: 'profile-1',
    ...overrides,
  });

  it('creates an email trigger with its own address, defaulting to the creator as sender', async () => {
    const response = await call('POST', '', emailTrigger());

    expect(response.status).toBe(201);
    const created = (await response.json()) as {
      id: string;
      sourceType: string;
      emailConfig: { address: string; allowedSenders: string[] };
    };
    expect(created.sourceType).toBe('email');
    expect(created.emailConfig.address).toMatch(ADDRESS_PATTERN);
    expect(created.emailConfig.allowedSenders).toEqual(['owner@example.com']);
    const stored = sqlite
      .prepare('SELECT address_key AS key FROM trigger_email_configs WHERE trigger_id = ?')
      .get(created.id) as { key: string };
    expect(created.emailConfig.address).toBe(`agent+${stored.key}@agents.fixture.example`);

    const listed = (await (await call('GET', '')).json()) as {
      triggers: Array<{ id: string; emailConfig?: { address: string } }>;
    };
    expect(listed.triggers.find((trigger) => trigger.id === created.id)?.emailConfig?.address).toBe(
      created.emailConfig.address
    );
  });

  it('normalizes and dedupes allowed senders, and updates them in place', async () => {
    const created = (await (
      await call(
        'POST',
        '',
        emailTrigger({
          emailConfig: {
            allowedSenders: ['Alice@Example.com', 'alice@example.com', 'bob@example.org'],
          },
        })
      )
    ).json()) as { id: string; emailConfig: { address: string; allowedSenders: string[] } };
    expect(created.emailConfig.allowedSenders).toEqual(['alice@example.com', 'bob@example.org']);

    const patched = await call('PATCH', `/${created.id}`, {
      emailConfig: { allowedSenders: ['carol@example.net'] },
    });

    expect(patched.status).toBe(200);
    const updated = (await patched.json()) as {
      emailConfig: { address: string; allowedSenders: string[] };
    };
    expect(updated.emailConfig).toEqual({
      address: created.emailConfig.address,
      allowedSenders: ['carol@example.net'],
    });
  });

  it('refuses email triggers while the binding exists but no admin has turned agent email on', async () => {
    sqlite.prepare("DELETE FROM platform_settings WHERE key = 'agent_email.setup'").run();

    const response = await call('POST', '', emailTrigger());

    expect(response.status).toBe(409);
    expect(sqlite.prepare('SELECT count(*) AS n FROM triggers').get()).toEqual({ n: 0 });
    // Control: the same request succeeds once the setup has run.
    await markAgentEmailSetUp(env);
    expect((await call('POST', '', emailTrigger())).status).toBe(201);
  });

  it('refuses email triggers when this deployment has no agent email binding', async () => {
    const response = await call('POST', '', emailTrigger(), { ...env, AGENT_EMAIL: undefined });

    expect(response.status).toBe(409);
    expect(sqlite.prepare('SELECT count(*) AS n FROM triggers').get()).toEqual({ n: 0 });
  });

  it('requires an agent profile, on create and on update', async () => {
    expect((await call('POST', '', emailTrigger({ agentProfileId: undefined }))).status).toBe(400);
    const created = (await (await call('POST', '', emailTrigger())).json()) as { id: string };

    expect((await call('PATCH', `/${created.id}`, { agentProfileId: null })).status).toBe(400);
  });

  it('rejects emailConfig on other trigger types and senders over the configured cap', async () => {
    const cron = await call('POST', '', {
      name: 'Nightly',
      sourceType: 'cron',
      cronExpression: '0 9 * * *',
      promptTemplate: 'Review',
      emailConfig: { allowedSenders: ['a@example.com'] },
    });
    expect(cron.status).toBe(400);

    await updateAdminSettings(env, {
      changes: [{ name: 'agentEmail.maxAllowedSenders', value: 2 }],
      actorUserId: 'admin-1',
    });
    const tooMany = await call(
      'POST',
      '',
      emailTrigger({
        emailConfig: { allowedSenders: ['a@example.com', 'b@example.com', 'c@example.com'] },
      })
    );
    expect(tooMany.status).toBe(400);
    const atCap = await call(
      'POST',
      '',
      emailTrigger({ emailConfig: { allowedSenders: ['a@example.com', 'b@example.com'] } })
    );
    expect(atCap.status).toBe(201);
  });

  it('previews with a sample email and refuses Run now', async () => {
    const created = (await (await call('POST', '', emailTrigger())).json()) as { id: string };

    const preview = await call('POST', `/${created.id}/test`, {});
    expect(preview.status).toBe(200);
    expect(((await preview.json()) as { renderedPrompt: string }).renderedPrompt).toContain(
      'Email from owner@example.com: Hi! This is an example email body'
    );

    const run = await call('POST', `/${created.id}/run`, {});
    expect(run.status).toBe(409);
    expect(sqlite.prepare('SELECT count(*) AS n FROM trigger_executions').get()).toEqual({ n: 0 });
  });
});
