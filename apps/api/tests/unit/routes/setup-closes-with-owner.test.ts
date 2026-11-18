/**
 * First-run setup must be closed on an install that already has an owner.
 *
 * Production and staging were installed before the setup wizard (#1528) and never wrote
 * `setup.completed`, so `/api/setup/*` stayed open behind SETUP_TOKEN for about four months.
 * On 2026-11-12 a token read from a public deploy log completed setup on production with a
 * login provider the caller controlled. These tests run the real routes against the real
 * `users` schema on a real SQL engine.
 */
import { readFileSync } from 'node:fs';

import { SYSTEM_USER_ID } from '@simple-agent-manager/shared';
import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { AppError } from '../../../src/middleware/error';
import { setupRoutes } from '../../../src/routes/setup';
import { generateEncryptionKey } from '../../../src/services/encryption';
import { __resetPlatformConfigCacheForTest } from '../../../src/services/platform-config';
import { createAllSchemaTables, createMemoryKv, createSqliteD1 } from '../../helpers/sqlite-d1';

const TOKEN = 'setup-token';
const OWNER_ID = 'owner-1';

/** A complete GitLab login config, so /complete would succeed if it were allowed to run. */
const GITLAB_CONFIG = {
  gitlab: {
    host: 'https://gitlab.attacker.example',
    clientId: 'gitlab-client-id',
    clientSecret: 'gitlab-client-secret',
  },
};

let sqlite: Database.Database;

function createEnv(overrides: Partial<Env> = {}): Env {
  return {
    DATABASE: createSqliteD1(sqlite),
    KV: createMemoryKv(),
    BASE_DOMAIN: 'example.com',
    ENCRYPTION_KEY: generateEncryptionKey(),
    SETUP_TOKEN: TOKEN,
    ...overrides,
  } as Env;
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

function insertUser(id: string, role: string, status: string): void {
  const now = Date.parse('2026-02-15T12:00:00Z');
  sqlite
    .prepare(
      `INSERT INTO users (id, email, email_verified, name, role, status, created_at, updated_at)
       VALUES (?, ?, 1, ?, ?, ?, ?, ?)`
    )
    .run(id, `${id}@example.com`, id, role, status, now, now);
}

function setupCompletedRow() {
  return sqlite
    .prepare(
      `SELECT value, updated_by AS updatedBy FROM platform_settings WHERE key = 'setup.completed'`
    )
    .get() as { value: string; updatedBy: string } | undefined;
}

function gitlabSettingCount(): number {
  return (
    sqlite
      .prepare(`SELECT count(*) AS n FROM platform_settings WHERE key LIKE 'integration.gitlab.%'`)
      .get() as { n: number }
  ).n;
}

const request = (env: Env, path: string, body?: unknown, ip = '203.0.113.7') =>
  createApp().request(
    `/api/setup/${path}`,
    body === undefined
      ? { headers: { 'CF-Connecting-IP': ip } }
      : {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip },
          body: JSON.stringify(body),
        },
    env
  );

describe('first-run setup on an install that already has an owner', () => {
  beforeEach(() => {
    sqlite = new Database(':memory:');
    createAllSchemaTables(sqlite, schema);
    sqlite.exec(
      readFileSync(
        new URL('../../../src/db/migrations/0196_admin_settings.sql', import.meta.url),
        'utf8'
      )
    );
    // The migration-seeded sentinel every install carries (migration 0043).
    insertUser(SYSTEM_USER_ID, 'user', 'system');
    __resetPlatformConfigCacheForTest();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    sqlite.close();
  });

  it('closes every setup route when a superadmin exists but setup.completed was never written', async () => {
    insertUser(OWNER_ID, 'superadmin', 'active');
    const env = createEnv();

    const status = await request(env, 'status');
    expect(status.status).toBe(410);
    await expect(status.json()).resolves.toMatchObject({ error: 'SETUP_CLOSED' });

    // The leaked token no longer opens anything, and the attacker's provider is never stored.
    expect((await request(env, 'verify', { token: TOKEN })).status).toBe(410);
    const complete = await request(env, 'complete', { token: TOKEN, config: GITLAB_CONFIG });
    expect(complete.status).toBe(410);
    expect(gitlabSettingCount()).toBe(0);

    // Recorded, so demoting or removing the owner later cannot reopen setup.
    expect(setupCompletedRow()).toEqual({ value: 'true', updatedBy: OWNER_ID });
  });

  it('stays closed after the owner is no longer a superadmin', async () => {
    insertUser(OWNER_ID, 'superadmin', 'active');
    const env = createEnv();
    expect((await request(env, 'status')).status).toBe(410);

    sqlite.prepare(`UPDATE users SET role = 'user' WHERE id = ?`).run(OWNER_ID);

    expect((await request(env, 'status')).status).toBe(410);
  });

  it('keeps setup open on an install without an active owner', async () => {
    // Neither the system sentinel, a suspended superadmin nor an ordinary user is an owner.
    insertUser('suspended-admin', 'superadmin', 'suspended');
    insertUser('member-1', 'user', 'active');
    const env = createEnv();

    const status = await request(env, 'status');
    expect(status.status).toBe(200);
    await expect(status.json()).resolves.toMatchObject({ open: true, completed: false });
    expect((await request(env, 'verify', { token: TOKEN })).status).toBe(200);
    expect(setupCompletedRow()).toBeUndefined();
  });

  it('does not count the system sentinel as an owner even with a superadmin role', async () => {
    sqlite
      .prepare(`UPDATE users SET role = 'superadmin', status = 'active' WHERE id = ?`)
      .run(SYSTEM_USER_ID);

    expect((await request(createEnv(), 'status')).status).toBe(200);
  });

  it('still lets SETUP_FORCE reopen setup on an owned install for lockout recovery', async () => {
    insertUser(OWNER_ID, 'superadmin', 'active');
    const env = createEnv({ SETUP_FORCE: 'true' });

    const status = await request(env, 'status');
    expect(status.status).toBe(200);
    await expect(status.json()).resolves.toMatchObject({ open: true, forced: true });
    expect(setupCompletedRow()).toBeUndefined();
  });

  it('stays closed when recording setup.completed fails', async () => {
    insertUser(OWNER_ID, 'superadmin', 'active');
    const env = createEnv();
    const database = env.DATABASE;
    const failingPrepare = (sql: string) => {
      if (sql.includes('INSERT INTO platform_settings')) throw new Error('D1 write failed');
      return database.prepare(sql);
    };
    const failingEnv = { ...env, DATABASE: { ...database, prepare: failingPrepare } } as Env;
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    expect((await request(failingEnv, 'status')).status).toBe(410);
    expect(setupCompletedRow()).toBeUndefined();
  });
});

describe('setup token attempt rate limit', () => {
  beforeEach(() => {
    sqlite = new Database(':memory:');
    createAllSchemaTables(sqlite, schema);
    sqlite.exec(
      readFileSync(
        new URL('../../../src/db/migrations/0196_admin_settings.sql', import.meta.url),
        'utf8'
      )
    );
    __resetPlatformConfigCacheForTest();
  });

  afterEach(() => sqlite.close());

  const guess = (env: Env, headers: Record<string, string>) =>
    createApp().request(
      '/api/setup/verify',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify({ token: 'wrong-guess' }),
      },
      env
    );

  it('cannot be escaped by rotating client-controlled headers', async () => {
    const env = createEnv({ SETUP_RATE_LIMIT_MAX_ATTEMPTS: '2' } as Partial<Env>);

    // No CF-Connecting-IP and a fresh User-Agent and X-Forwarded-For on every guess.
    const statuses: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      const res = await guess(env, { 'User-Agent': `bot-${i}`, 'X-Forwarded-For': `10.0.0.${i}` });
      statuses.push(res.status);
    }

    expect(statuses).toEqual([401, 401, 429]);
  });

  it('still gives each Cloudflare client address its own budget', async () => {
    const env = createEnv({ SETUP_RATE_LIMIT_MAX_ATTEMPTS: '1' } as Partial<Env>);

    expect((await guess(env, { 'CF-Connecting-IP': '198.51.100.1' })).status).toBe(401);
    expect((await guess(env, { 'CF-Connecting-IP': '198.51.100.1' })).status).toBe(429);
    expect((await guess(env, { 'CF-Connecting-IP': '198.51.100.2' })).status).toBe(401);
  });
});
