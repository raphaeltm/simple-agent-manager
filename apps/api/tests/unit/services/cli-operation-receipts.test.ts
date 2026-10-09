import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppError } from '../../../src/middleware/error';
import type { Env } from '../../../src/env';
import { cliOperationReceipt } from '../../../src/services/cli-operation-receipts';

vi.mock('../../../src/middleware/auth', () => ({ getUserId: () => 'user' }));
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
  effects = 0;
  failAfterCommit = false;
  app = new Hono<{ Bindings: Env }>();
  app.onError((err, c) =>
    err instanceof AppError
      ? c.json(err.toJSON(), err.statusCode as 400)
      : c.json({ error: 'INTERNAL_ERROR' }, 500)
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
