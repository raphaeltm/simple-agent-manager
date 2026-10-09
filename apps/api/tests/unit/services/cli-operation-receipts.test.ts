import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import { AppError } from '../../../src/middleware/error';
import { cliOperationReceiptRoutes } from '../../../src/routes/cli-operation-receipts';
import { cliOperationReceipt } from '../../../src/services/cli-operation-receipts';

const actor = vi.hoisted(() => ({ id: 'user', allowed: true }));
vi.mock('drizzle-orm/d1', () => ({ drizzle: () => ({}) }));
vi.mock('../../../src/middleware/project-auth', () => ({
  requireProjectCapability: () => {
    if (!actor.allowed) throw new AppError(403, 'FORBIDDEN', 'Denied');
  },
}));
vi.mock('../../../src/middleware/auth', () => ({
  getUserId: () => actor.id,
  requireAuth: () => async (_c: unknown, next: () => Promise<void>) => next(),
  requireApproved: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));
let db: Database.Database;
let effects: number;
let failAfterCommit: boolean;
let app: Hono<{ Bindings: Env }>;
let env: Env;
beforeEach(() => {
  db = new Database(':memory:');
  db.exec(
    "CREATE TABLE projects(id TEXT PRIMARY KEY); CREATE TABLE users(id TEXT PRIMARY KEY); INSERT INTO projects VALUES('project'); INSERT INTO users VALUES('user');"
  );
  db.exec(
    readFileSync(join(process.cwd(), 'src/db/migrations/0189_cli_operation_receipts.sql'), 'utf8')
  );
  const database = {
    prepare: (sql: string) => ({
      bind: (...values: unknown[]) => ({
        run: async () => ({ meta: { changes: db.prepare(sql).run(...values).changes } }),
        first: async () => db.prepare(sql).get(...values) ?? null,
      }),
    }),
  };
  env = { DATABASE: database } as unknown as Env;
  actor.allowed = true;
  actor.id = 'user';
  effects = 0;
  failAfterCommit = false;
  app = new Hono<{ Bindings: Env }>();
  app.onError((err, c) =>
    err instanceof AppError
      ? c.json(err.toJSON(), err.statusCode as 400)
      : c.json({ error: 'INTERNAL_ERROR' }, 500)
  );
  app.route('/api/projects/:projectId/operation-receipts', cliOperationReceiptRoutes);
  app.post(
    '/api/projects/:projectId/tasks/submit',
    async (_c, next) => {
      if (!actor.allowed) throw new AppError(403, 'FORBIDDEN', 'Denied');
      await next();
    },
    cliOperationReceipt,
    (c) => {
      effects++;
      return c.json({ taskId: 'private-own' }, 202);
    }
  );
  app.post('/projects/:projectId/submit', cliOperationReceipt, (c) => {
    effects++;
    if (failAfterCommit) throw new Error('lost completion');
    return c.json({ taskId: 'task', sessionId: 'session', status: 'queued' }, 202);
  });
});
afterEach(() => db.close());
function submit(body = '{"message":"synthetic"}', key = 'request-1') {
  return app.request(
    'http://fixture/projects/project/submit',
    {
      method: 'POST',
      headers: { 'Idempotency-Key': key, 'Content-Type': 'application/json' },
      body,
    },
    env
  );
}
describe('CLI operation receipts with real SQLite migration', () => {
  it('replays one accepted identity after a lost response without duplicate effects', async () => {
    const first = await submit();
    const second = await submit();
    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    expect(await second.json()).toEqual(await first.json());
    expect(second.headers.get('SAM-Receipt-Replayed')).toBe('true');
    expect(effects).toBe(1);
    const stored = db.prepare('SELECT * FROM cli_operation_receipts').get();
    expect(JSON.stringify(stored)).not.toContain('synthetic');
  });
  it('rejects changed intent without executing it', async () => {
    await submit();
    const res = await submit('{"message":"changed"}');
    expect(res.status).toBe(409);
    expect(effects).toBe(1);
  });
  it('holds an uncertain crash reservation instead of replaying work', async () => {
    failAfterCommit = true;
    expect((await submit()).status).toBe(500);
    const res = await submit();
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'OUTCOME_UNKNOWN' });
    expect(effects).toBe(1);
  });
  it('rejects malformed keys before persistence or work', async () => {
    expect((await submit('{}', 'bad key')).status).toBe(400);
    expect(effects).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS count FROM cli_operation_receipts').get()).toEqual({
      count: 0,
    });
  });
});

describe('receipt namespace and bounds', () => {
  it.each([
    ['CLI_RECEIPT_RESPONSE_MAX_BYTES', '0'],
    ['CLI_RECEIPT_RESPONSE_MAX_BYTES', 'abc'],
    ['CLI_RECEIPT_RESPONSE_MAX_BYTES', '1.5'],
    ['CLI_RECEIPT_REQUEST_MAX_BYTES', '0'],
    ['CLI_RECEIPT_REQUEST_MAX_BYTES', 'abc'],
    ['CLI_RECEIPT_REQUEST_MAX_BYTES', '1.5'],
  ] as const)(
    'rejects invalid server configuration %s=%s before reservation or side effects',
    async (field, value) => {
      env[field] = value;
      const response = await submit();
      expect(response.status).toBe(500);
      expect(await response.json()).toMatchObject({ error: 'INTERNAL_ERROR' });
      expect(effects).toBe(0);
      expect(db.prepare('SELECT COUNT(*) AS count FROM cli_operation_receipts').get()).toEqual({
        count: 0,
      });
    }
  );

  it('separates actors, projects and operation paths with identical keys', async () => {
    app.post('/projects/:projectId/prompt', cliOperationReceipt, (c) => {
      effects++;
      return c.json({ messageId: 'other' });
    });
    db.exec("INSERT INTO users VALUES('other'); INSERT INTO projects VALUES('other-project');");
    await submit();
    actor.id = 'other';
    await submit();
    actor.id = 'user';
    for (const path of ['/projects/other-project/submit', '/projects/project/prompt']) {
      await app.request(
        path,
        {
          method: 'POST',
          headers: { 'Idempotency-Key': 'request-1' },
          body: '{"message":"synthetic"}',
        },
        env
      );
    }
    expect(effects).toBe(4);
    expect(db.prepare('SELECT COUNT(*) AS count FROM cli_operation_receipts').get()).toEqual({
      count: 4,
    });
  });
  it('rejects oversized intent before reservation', async () => {
    env.CLI_RECEIPT_REQUEST_MAX_BYTES = '8';
    expect((await submit()).status).toBe(400);
    expect(effects).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS count FROM cli_operation_receipts').get()).toEqual({
      count: 0,
    });
  });
  it('holds an oversized successful receipt pending rather than caching partial output', async () => {
    env.CLI_RECEIPT_RESPONSE_MAX_BYTES = '8';
    expect((await submit()).status).toBe(202);
    expect((await submit()).status).toBe(409);
    expect(effects).toBe(1);
  });
  it('reserves only one concurrent execution', async () => {
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    app.post('/projects/:projectId/held', cliOperationReceipt, async (c) => {
      effects++;
      entered();
      await held;
      return c.json({ taskId: 'one' });
    });
    const request = () =>
      app.request(
        '/projects/project/held',
        { method: 'POST', headers: { 'Idempotency-Key': 'same' }, body: '{}' },
        env
      );
    const first = request();
    await started;
    const concurrent = await request();
    expect(concurrent.status).toBe(409);
    expect(await concurrent.json()).toMatchObject({ error: 'OUTCOME_UNKNOWN' });
    release();
    expect((await first).status).toBe(200);
    expect(effects).toBe(1);
  });
});

it('reconciliation is caller scoped and revoked access cannot replay or reserve', async () => {
  const init = { method: 'POST', headers: { 'Idempotency-Key': 'owned' }, body: '{}' };
  expect((await app.request('/api/projects/project/tasks/submit', init, env)).status).toBe(202);
  const query = '/api/projects/project/operation-receipts?key=owned&operation=submit';
  expect(await (await app.request(query, {}, env)).json()).toMatchObject({
    known: true,
    response: { taskId: 'private-own' },
  });
  actor.id = 'other';
  expect(await (await app.request(query, {}, env)).json()).toMatchObject({
    known: false,
    safeToResubmit: false,
  });
  actor.id = 'user';
  actor.allowed = false;
  expect((await app.request(query, {}, env)).status).toBe(403);
  expect((await app.request('/api/projects/project/tasks/submit', init, env)).status).toBe(403);
  expect(
    (
      await app.request(
        '/api/projects/project/tasks/submit',
        { ...init, headers: { 'Idempotency-Key': 'denied' } },
        env
      )
    ).status
  ).toBe(403);
  expect(effects).toBe(1);
  expect(db.prepare('SELECT COUNT(*) AS count FROM cli_operation_receipts').get()).toEqual({
    count: 1,
  });
});
