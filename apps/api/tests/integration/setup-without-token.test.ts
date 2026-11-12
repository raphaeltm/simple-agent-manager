/**
 * `/setup` on an installation with no setup token (a self-hosted celld box, whose owner is made
 * by `pnpm selfhost:create-account`). It used to be a dead end ("This instance has no setup
 * token") forever. Once an active superadmin exists it is recorded as complete, so the page
 * says SAM is set up. Real SQL engine, production route.
 */
import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';

import * as schema from '../../src/db/schema';
import type { Env } from '../../src/env';
import { handleAppError } from '../../src/middleware/app-error-handler';
import { setupRoutes } from '../../src/routes/setup';
import { __resetPlatformConfigCacheForTest } from '../../src/services/platform-config';
import { createAllSchemaTables, createMemoryKv, createSqliteD1 } from '../helpers/sqlite-d1';

describe('GET /api/setup/status without a setup token', () => {
  let sqlite: Database.Database;
  const app = new Hono<{ Bindings: Env }>();
  app.onError(handleAppError);
  app.route('/api/setup', setupRoutes);

  beforeEach(() => {
    sqlite = new Database(':memory:');
    createAllSchemaTables(sqlite, schema);
    // The migration-seeded sentinel (status 'system') must never count as an owner.
    sqlite
      .prepare(
        `INSERT INTO users (id, email, email_verified, name, role, status, created_at, updated_at)
         VALUES ('system_anonymous_trials', 'system@internal', 0, 'System', 'superadmin', 'system', 0, 0)`
      )
      .run();
    __resetPlatformConfigCacheForTest();
  });

  function env(overrides: Partial<Env> = {}): Env {
    return {
      DATABASE: createSqliteD1(sqlite),
      KV: createMemoryKv(),
      BASE_DOMAIN: 'example.com',
      ENCRYPTION_KEY: 'test-key',
      ...overrides,
    } as Env;
  }

  function addUser(id: string, role: string, status: string) {
    sqlite
      .prepare(
        `INSERT INTO users (id, email, email_verified, name, role, status, created_at, updated_at)
         VALUES (?, ?, 1, ?, ?, ?, 1, 1)`
      )
      .run(id, `${id}@example.com`, id, role, status);
  }

  function completedSetting(): string | undefined {
    const row = sqlite
      .prepare(`SELECT value FROM platform_settings WHERE key = 'setup.completed'`)
      .get() as { value: string } | undefined;
    return row?.value;
  }

  async function status(e: Env) {
    const response = await app.request('/api/setup/status', {}, e);
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  }

  it('closes setup once an active superadmin exists, and records it', async () => {
    addUser('owner', 'superadmin', 'active');
    const result = await status(env());
    expect(result.status).toBe(410);
    expect(result.body).toMatchObject({ error: 'SETUP_CLOSED' });
    expect(completedSetting()).toBe('true');
  });

  it('stays open with no owner yet (only the sentinel, a pending or a plain user)', async () => {
    addUser('pending-admin', 'superadmin', 'pending');
    addUser('plain', 'user', 'active');
    const result = await status(env());
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ completed: false, tokenConfigured: false });
    expect(completedSetting()).toBeUndefined();
  });

  it('control: an install with a setup token is unchanged, even with an owner', async () => {
    addUser('owner', 'superadmin', 'active');
    const result = await status(env({ SETUP_TOKEN: 'installer-token' }));
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ completed: false, tokenConfigured: true });
    expect(completedSetting()).toBeUndefined();
  });

  it('control: SETUP_FORCE keeps setup open', async () => {
    addUser('owner', 'superadmin', 'active');
    const result = await status(env({ SETUP_FORCE: 'true' }));
    expect(result.status).toBe(200);
    expect(completedSetting()).toBeUndefined();
  });
});
