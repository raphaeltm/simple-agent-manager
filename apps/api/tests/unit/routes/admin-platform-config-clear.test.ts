/**
 * Admin → Integrations hardening after the 2026-11-12 setup takeover:
 * - clearing an integration group deletes its stored rows and audits each as `reset`
 * - a stored value is labelled as stored (never as an environment fallback) with its writer
 * - every change emails the superadmins, best-effort, without failing the save
 *
 * Runs the real route against a real SQLite engine built from the drizzle schema, with a fake
 * agent-email send binding at the network boundary.
 */
import { readFileSync } from 'node:fs';

import * as schema from '@simple-agent-manager/worker-core/schema';
import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import { AppError } from '../../../src/middleware/error';
import { __resetAdminSettingsCacheForTest } from '../../../src/services/admin-settings-resolution';
import { encrypt, generateEncryptionKey } from '../../../src/services/encryption';
import {
  __resetPlatformConfigCacheForTest,
  getGitLabOAuthConfig,
} from '../../../src/services/platform-config';
import { createSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

vi.mock('../../../src/middleware/auth', () => ({
  requireAuth: () => async (c: any, next: any) => {
    c.set('auth', { user: { id: 'superadmin-1', role: 'superadmin', status: 'active' } });
    await next();
  },
  requireApproved: () => async (_c: any, next: any) => next(),
  requireSuperadmin: () => async (_c: any, next: any) => next(),
  getUserId: () => 'superadmin-1',
}));

const { adminPlatformConfigRoutes } = await import('../../../src/routes/admin-platform-config');

interface SentEmail {
  from: { email: string; name: string };
  to: string;
  subject: string;
  text: string;
}

function createEnv(overrides: Partial<Env> = {}, send?: (message: SentEmail) => Promise<unknown>) {
  const sqlite = new Database(':memory:');
  createSchemaTables(sqlite, [
    schema.users,
    schema.platformSettings,
    schema.platformCredentials,
    schema.projects,
    schema.projectMembers,
  ]);
  sqlite.exec(
    readFileSync(
      new URL('../../../src/db/migrations/0196_admin_settings.sql', import.meta.url),
      'utf8'
    )
  );
  sqlite.exec(`
    INSERT INTO users (id, email, name, role, status) VALUES
      ('system_anonymous_trials', 'system@internal', 'System', 'superadmin', 'system'),
      ('superadmin-1', 'owner@example.com', 'Owner', 'superadmin', 'active'),
      ('superadmin-2', 'second-owner@example.com', NULL, 'superadmin', 'active'),
      ('suspended-admin', 'gone@example.com', 'Gone', 'superadmin', 'suspended'),
      ('admin-1', 'admin@example.com', 'Admin', 'admin', 'active');
  `);
  const sent: SentEmail[] = [];
  const env = {
    KV: { get: async () => null },
    DATABASE: createSqliteD1(sqlite),
    BASE_DOMAIN: 'example.com',
    ENCRYPTION_KEY: generateEncryptionKey(),
    AGENT_EMAIL: {
      send: async (message: SentEmail) => {
        if (send) await send(message);
        sent.push(message);
        return { messageId: `msg-${sent.length}` };
      },
    },
    ...overrides,
  } as unknown as Env;
  return { env, sent };
}

/** Seeds GitLab exactly as `POST /api/setup/complete` writes it: actor = system sentinel. */
async function seedSetupWrittenGitLab(env: Env) {
  const now = '2026-11-12T04:07:00.000Z';
  await env.DATABASE.prepare(
    `INSERT INTO platform_settings (key, value, updated_at, updated_by) VALUES
      ('integration.gitlab.host', 'https://gitlab.unknown.example', ?, 'system_anonymous_trials'),
      ('integration.gitlab.clientId', 'gitlab-client-abcdef', ?, 'system_anonymous_trials')`
  )
    .bind(now, now)
    .run();
  const encrypted = await encrypt('gitlab-secret-abcdefgh', env.ENCRYPTION_KEY!);
  await env.DATABASE.prepare(
    `INSERT INTO platform_credentials
       (id, credential_type, provider, credential_kind, label, encrypted_token, iv, is_enabled, created_by, created_at, updated_by, updated_at)
     VALUES ('cred-gitlab', 'platform-integration', 'gitlab', 'gitlab.clientSecret', 'GitLab client secret', ?, ?, 1,
       'system_anonymous_trials', ?, 'system_anonymous_trials', ?)`
  )
    .bind(encrypted.ciphertext, encrypted.iv, now, now)
    .run();
}

function createApp() {
  const app = new Hono<{ Bindings: Env }>();
  app.onError((err, c) =>
    err instanceof AppError
      ? c.json(err.toJSON(), err.statusCode)
      : c.json({ error: 'INTERNAL_ERROR', message: err.message }, 500)
  );
  app.route('/api/admin/platform-config', adminPlatformConfigRoutes);
  return app;
}

/** A Workers-like execution context whose `waitUntil` work the test can await. */
function executionContext() {
  const pending: Promise<unknown>[] = [];
  return {
    ctx: {
      waitUntil: (promise: Promise<unknown>) => pending.push(promise),
      passThroughOnException: () => undefined,
      props: {},
    } as unknown as ExecutionContext,
    settle: () => Promise.all(pending),
    pending,
  };
}

async function put(env: Env, config: unknown, ctx?: ExecutionContext) {
  return createApp().request(
    '/api/admin/platform-config',
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ config }),
    },
    env,
    ctx
  );
}

async function rows(env: Env, sql: string) {
  return (await env.DATABASE.prepare(sql).all()).results;
}

describe('Admin → Integrations clear, source labels and owner alerts', () => {
  beforeEach(() => {
    __resetAdminSettingsCacheForTest();
    __resetPlatformConfigCacheForTest();
  });

  it('labels setup-written GitLab values as stored in SAM by first-run setup, never as environment', async () => {
    // The environment sets GitLab too, so a mislabel would have a plausible-looking value to show.
    const { env } = createEnv({
      GITLAB_HOST: 'https://gitlab.env.example',
      GITLAB_CLIENT_ID: 'env-gitlab-client',
      GITLAB_CLIENT_SECRET: 'env-gitlab-secret',
    } as Partial<Env>);
    await seedSetupWrittenGitLab(env);

    const res = await createApp().request('/api/admin/platform-config', {}, env);
    expect(res.status).toBe(200);
    const { status } = (await res.json()) as any;
    const gitlab = status.integrations.gitlabOAuth;
    expect(gitlab).toMatchObject({
      configured: true,
      source: 'runtime',
      label: 'stored in SAM',
      clearable: true,
    });
    for (const field of ['host', 'clientId', 'clientSecret']) {
      expect(gitlab.fields[field]).toMatchObject({
        source: 'runtime',
        label: 'stored in SAM',
        updatedBy: 'system_anonymous_trials',
        updatedByLabel: 'first-run setup (unauthenticated)',
      });
      expect(gitlab.fields[field].label).not.toMatch(/environment/i);
    }
    // Liveness control: an env-only integration in the same response is labelled as env.
    expect(status.integrations.githubOAuth.label).toBe('not configured');
  });

  it('names a stored value’s admin writer by name and email', async () => {
    const { env } = createEnv();
    const res = await put(env, {
      gitlab: {
        host: 'https://gitlab.admin.example.com',
        clientId: 'gitlab-admin-client',
        clientSecret: 'gitlab-admin-secret',
      },
    });
    expect(res.status).toBe(200);
    const { status } = (await res.json()) as any;
    expect(status.integrations.gitlabOAuth.fields.clientId.updatedByLabel).toBe(
      'Owner <owner@example.com>'
    );
  });

  it('clears a group: deletes its settings and secret rows, audits each as reset, and reveals the env fallback', async () => {
    const { env } = createEnv({
      GITLAB_HOST: 'https://gitlab.env.example',
      GITLAB_CLIENT_ID: 'env-gitlab-client',
      GITLAB_CLIENT_SECRET: 'env-gitlab-secret',
    } as Partial<Env>);
    await seedSetupWrittenGitLab(env);
    // An unrelated stored integration must survive the clear.
    await put(env, { github: { webhookSecret: 'webhook-secret-0123456789' } });

    const res = await put(env, { clear: ['gitlabOAuth'] });
    expect(res.status).toBe(200);
    const { status } = (await res.json()) as any;
    expect(status.integrations.gitlabOAuth).toMatchObject({
      configured: true,
      source: 'environment',
      label: 'Worker environment fallback',
      clearable: false,
    });

    expect(
      await rows(env, "SELECT key FROM platform_settings WHERE key LIKE 'integration.gitlab.%'")
    ).toEqual([]);
    expect(
      await rows(env, "SELECT id FROM platform_credentials WHERE provider = 'gitlab'")
    ).toEqual([]);
    expect(
      await rows(
        env,
        "SELECT name, action, actor_user_id AS actor FROM admin_settings_audit WHERE action = 'reset' ORDER BY name"
      )
    ).toEqual([
      { name: 'integration.gitlab.clientId', action: 'reset', actor: 'superadmin-1' },
      { name: 'integration.gitlab.clientSecret', action: 'reset', actor: 'superadmin-1' },
      { name: 'integration.gitlab.host', action: 'reset', actor: 'superadmin-1' },
    ]);
    expect(
      await rows(
        env,
        "SELECT credential_kind AS kind FROM platform_credentials WHERE provider = 'github'"
      )
    ).toEqual([{ kind: 'github.webhookSecret' }]);
    await expect(getGitLabOAuthConfig(env)).resolves.toMatchObject({
      host: 'https://gitlab.env.example',
      clientId: 'env-gitlab-client',
    });
  });

  it('clears to unset when no environment fallback exists, even though the pair would be incomplete', async () => {
    const { env } = createEnv({ GITLAB_CLIENT_ID: 'env-only-half' } as Partial<Env>);
    await seedSetupWrittenGitLab(env);
    const res = await put(env, { clear: ['gitlabOAuth'] });
    expect(res.status).toBe(200);
    await expect(getGitLabOAuthConfig(env)).resolves.toBeNull();
  });

  it('clears the legacy GitHub App fields and audits only rows that existed', async () => {
    const { env } = createEnv();
    await env.DATABASE.prepare(
      `INSERT INTO platform_settings (key, value, updated_at, updated_by)
       VALUES ('integration.github.appId', '12345', '2026-11-01T00:00:00Z', 'superadmin-1')`
    ).run();

    const res = await put(env, { clear: ['githubApp', 'githubOAuth'] });
    expect(res.status).toBe(200);
    expect(
      await rows(env, "SELECT key FROM platform_settings WHERE key LIKE 'integration.github.%'")
    ).toEqual([]);
    // Only appId was stored: no reset is recorded for the slug, the key, or GitHub OAuth.
    expect(await rows(env, 'SELECT name, action FROM admin_settings_audit')).toEqual([
      { name: 'integration.github.appId', action: 'reset' },
    ]);
  });

  it('rejects clearing and setting the same group in one save, and changes nothing', async () => {
    const { env } = createEnv();
    await seedSetupWrittenGitLab(env);
    const res = await put(env, {
      clear: ['gitlabOAuth'],
      gitlab: { clientId: 'replacement-client' },
    });
    expect(res.status).toBe(400);
    expect(
      await rows(env, "SELECT key FROM platform_settings WHERE key LIKE 'integration.gitlab.%'")
    ).toHaveLength(2);
    expect(await rows(env, 'SELECT id FROM admin_settings_audit')).toEqual([]);
  });

  it('rejects an unknown clear group', async () => {
    const { env } = createEnv();
    const res = await put(env, { clear: ['agentEmail'] });
    expect(res.status).toBe(400);
  });

  it('emails every active superadmin about a clear, naming the actor and linking the admin page', async () => {
    const { env, sent } = createEnv();
    await seedSetupWrittenGitLab(env);
    const { ctx, settle, pending } = executionContext();

    const res = await put(env, { clear: ['gitlabOAuth'] }, ctx);
    expect(res.status).toBe(200);
    expect(pending).toHaveLength(1);
    await settle();

    expect(sent.map((message) => message.to).sort()).toEqual([
      'owner@example.com',
      'second-owner@example.com',
    ]);
    const [message] = sent;
    expect(message!.from.email).toBe('security@agents.example.com');
    expect(message!.subject).toBe('SAM security alert: GitLab OAuth settings changed');
    expect(message!.text).toContain('By: Owner <owner@example.com>');
    expect(message!.text).toContain('- GitLab OAuth: host cleared');
    expect(message!.text).toContain('- GitLab OAuth: client secret cleared');
    expect(message!.text).toContain('https://app.example.com/admin/integrations');
    // Names only: a secret value never reaches the email.
    expect(message!.text).not.toContain('gitlab-secret-abcdefgh');
  });

  it('a failing email send never fails or rolls back the save', async () => {
    const { env } = createEnv({}, async () => {
      throw new Error('email provider down');
    });
    const { ctx, settle } = executionContext();
    const res = await put(env, { github: { webhookSecret: 'webhook-secret-0123456789' } }, ctx);
    expect(res.status).toBe(200);
    await expect(settle()).resolves.toBeDefined();
    expect(
      await rows(
        env,
        "SELECT credential_kind AS kind FROM platform_credentials WHERE provider = 'github'"
      )
    ).toEqual([{ kind: 'github.webhookSecret' }]);
  });

  it('a save without changes sends no alert', async () => {
    const { env, sent } = createEnv();
    const { ctx, settle, pending } = executionContext();
    const res = await put(env, {}, ctx);
    expect(res.status).toBe(200);
    await settle();
    expect(pending).toHaveLength(0);
    expect(sent).toEqual([]);
  });

  it('a clear of a group with nothing stored deletes nothing and leaves the revision alone', async () => {
    const { env } = createEnv();
    const before = await rows(env, 'SELECT revision FROM admin_settings_revision');
    const res = await put(env, { clear: ['gitlabOAuth'] });
    expect(res.status).toBe(200);
    expect(await rows(env, 'SELECT revision FROM admin_settings_revision')).toEqual(before);
    expect(await rows(env, 'SELECT id FROM admin_settings_audit')).toEqual([]);
  });

  it('a clear that deletes rows is fenced by the settings revision', async () => {
    const { env } = createEnv();
    await seedSetupWrittenGitLab(env);
    const [{ revision: before }] = (await rows(
      env,
      'SELECT revision FROM admin_settings_revision'
    )) as Array<{ revision: number }>;
    expect((await put(env, { clear: ['gitlabOAuth'] })).status).toBe(200);
    const [{ revision: after }] = (await rows(
      env,
      'SELECT revision FROM admin_settings_revision'
    )) as Array<{ revision: number }>;
    expect(after).toBe(before + 1);
    // Every audited reset carries the revision of the batch that deleted its row.
    expect(
      await rows(env, "SELECT DISTINCT revision FROM admin_settings_audit WHERE action = 'reset'")
    ).toEqual([{ revision: after }]);
  });
});
