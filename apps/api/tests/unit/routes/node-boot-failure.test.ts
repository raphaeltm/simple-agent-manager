import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { AppError } from '../../../src/middleware/error';
import { nodeBootFailureRoutes } from '../../../src/routes/node-boot-failure';
import { verifyCallbackToken } from '../../../src/services/jwt';
import { createAllSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';
vi.mock('../../../src/services/jwt', () => ({ verifyCallbackToken: vi.fn() }));
let sqlite: Database.Database;
let app: Hono<{ Bindings: Env }>;
beforeEach(() => {
  vi.clearAllMocks();
  sqlite = new Database(':memory:');
  createAllSchemaTables(sqlite, schema);
  sqlite.exec(
    "INSERT INTO nodes (id, user_id, name, status, node_class, runtime, node_role) VALUES ('node', 'user', 'Node', 'running', 'managed', 'vm', 'workspace')"
  );
  vi.mocked(verifyCallbackToken).mockResolvedValue({
    workspace: 'node',
    scope: 'node',
    type: 'callback',
  } as never);
  app = new Hono<{ Bindings: Env }>();
  app.onError((e, c) => c.json({ error: e.message }, e instanceof AppError ? e.statusCode : 500));
  app.route('/api/nodes', nodeBootFailureRoutes);
  // The callback must terminate before session-cookie auth on the shared prefix.
  app.use('/api/nodes/*', (c) => c.json({ error: 'session required' }, 401));
});
afterEach(() => sqlite.close());
function send(reason = 'origin_ca_bootstrap') {
  return app.request(
    '/api/nodes/node/boot-failure',
    {
      method: 'POST',
      headers: { Authorization: 'Bearer canary-secret', 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason }),
    },
    { DATABASE: createSqliteD1(sqlite) } as Env
  );
}
describe('boot failure callback', () => {
  it('accepts the live node JWT through combined router wiring', async () => {
    const res = await send();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ accepted: true });
    expect(sqlite.prepare('SELECT error_message,health_status FROM nodes').get()).toEqual({
      error_message: 'Node boot failed: origin_ca_bootstrap',
      health_status: 'unhealthy',
    });
    expect(verifyCallbackToken).toHaveBeenCalledWith('canary-secret', expect.anything(), {
      expectedScope: 'node',
    });
  });
  it.each(['last_heartbeat_at', 'agent_ready_at'])(
    'ignores delayed reports after %s',
    async (field) => {
      sqlite.exec(`UPDATE nodes SET ${field} = '2026-10-08T12:00:00Z'`);
      expect(await (await send()).json()).toEqual({ accepted: false });
      expect(sqlite.prepare('SELECT error_message FROM nodes').get()).toEqual({
        error_message: null,
      });
    }
  );
  it.each(['deleted', 'destroying', 'stopped'])('rejects %s nodes', async (status) => {
    sqlite.prepare('UPDATE nodes SET status = ?').run(status);
    expect((await send()).status).toBe(410);
  });
  it.each(['workspace', 'other-node'])('rejects %s identity', async (kind) => {
    vi.mocked(verifyCallbackToken).mockResolvedValue({
      workspace: kind === 'workspace' ? 'node' : 'other-node',
      scope: kind === 'workspace' ? 'workspace' : 'node',
      type: 'callback',
    } as never);
    expect((await send()).status).toBe(kind === 'workspace' ? 403 : 401);
  });
  it('rejects non-allowlisted diagnostic data', async () => {
    expect((await send('secret-canary arbitrary stderr')).status).toBe(400);
    expect(sqlite.prepare('SELECT error_message FROM nodes').get()).toEqual({
      error_message: null,
    });
  });
});
