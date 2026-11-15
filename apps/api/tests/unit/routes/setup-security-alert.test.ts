/**
 * `POST /api/setup/complete` emails the owner. In the 2026-11-12 incident someone holding the
 * leaked setup token completed setup and nobody was told for 2.5 days.
 */
import { readFileSync } from 'node:fs';

import * as schema from '@simple-agent-manager/worker-core/schema';
import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import { AppError } from '../../../src/middleware/error';
import { setupRoutes } from '../../../src/routes/setup';
import { __resetAdminSettingsCacheForTest } from '../../../src/services/admin-settings-resolution';
import { generateEncryptionKey } from '../../../src/services/encryption';
import { __resetPlatformConfigCacheForTest } from '../../../src/services/platform-config';
import { createMemoryKv, createSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

function createEnv(overrides: Partial<Env> = {}) {
  const sqlite = new Database(':memory:');
  createSchemaTables(sqlite, [schema.users, schema.platformSettings, schema.platformCredentials]);
  sqlite.exec(
    readFileSync(
      new URL('../../../src/db/migrations/0196_admin_settings.sql', import.meta.url),
      'utf8'
    )
  );
  sqlite.exec(
    `INSERT INTO users (id, email, role, status) VALUES ('system_anonymous_trials', 'system@internal', 'superadmin', 'system')`
  );
  const sent: Array<{ to: string; subject: string; text: string }> = [];
  const env = {
    DATABASE: createSqliteD1(sqlite),
    KV: createMemoryKv(),
    BASE_DOMAIN: 'example.com',
    ENCRYPTION_KEY: generateEncryptionKey(),
    SETUP_TOKEN: 'setup-token',
    AGENT_EMAIL: {
      send: async (message: { to: string; subject: string; text: string }) => {
        sent.push(message);
        return { messageId: 'm' };
      },
    },
    ...overrides,
  } as unknown as Env;
  return { env, sent };
}

function createApp() {
  const app = new Hono<{ Bindings: Env }>();
  app.onError((err, c) =>
    err instanceof AppError
      ? c.json(err.toJSON(), err.statusCode)
      : c.json({ error: 'INTERNAL_ERROR', message: err.message }, 500)
  );
  app.route('/api/setup', setupRoutes);
  return app;
}

describe('setup completion owner alert', () => {
  beforeEach(() => {
    __resetAdminSettingsCacheForTest();
    __resetPlatformConfigCacheForTest();
    vi.restoreAllMocks();
  });

  it('emails the installer owner what setup changed, naming the unauthenticated actor', async () => {
    const { env, sent } = createEnv({
      BOOTSTRAP_OWNER_EMAIL: 'Installer@Example.com',
    } as Partial<Env>);
    const pending: Promise<unknown>[] = [];
    const ctx = {
      waitUntil: (promise: Promise<unknown>) => pending.push(promise),
      passThroughOnException: () => undefined,
      props: {},
    } as unknown as ExecutionContext;

    const res = await createApp().request(
      '/api/setup/complete',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '198.51.100.40' },
        body: JSON.stringify({
          token: 'setup-token',
          config: {
            gitlab: {
              host: 'https://gitlab.example.com',
              clientId: 'gitlab-client-id',
              clientSecret: 'gitlab-client-secret',
            },
          },
        }),
      },
      env,
      ctx
    );

    expect(res.status).toBe(200);
    expect(pending).toHaveLength(1);
    await Promise.all(pending);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe('installer@example.com');
    expect(sent[0]!.subject).toBe('SAM security alert: first-run setup was completed');
    expect(sent[0]!.text).toContain('By: first-run setup (unauthenticated), using the setup token');
    expect(sent[0]!.text).toContain('- GitLab OAuth: client secret set');
    expect(sent[0]!.text).not.toContain('gitlab-client-secret');
  });

  it('a rejected setup attempt sends nothing', async () => {
    const { env, sent } = createEnv({
      BOOTSTRAP_OWNER_EMAIL: 'installer@example.com',
    } as Partial<Env>);
    const res = await createApp().request(
      '/api/setup/complete',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '198.51.100.41' },
        body: JSON.stringify({ token: 'wrong-token', config: {} }),
      },
      env
    );
    expect(res.status).toBe(401);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sent).toEqual([]);
  });
});
