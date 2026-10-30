import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { AppError } from '../../../src/middleware/error';
import { nodeLifecycleRoutes } from '../../../src/routes/node-lifecycle';
import { nodesRoutes } from '../../../src/routes/nodes';
import { createAllSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

// Only authentication transport is replaced; route, status transitions, projection,
// Drizzle and its SQLite predicates all run unchanged.
vi.mock('../../../src/middleware/auth', async (load) => ({
  ...(await load<typeof import('../../../src/middleware/auth')>()),
  getUserId: () => 'owner-1',
  requireAuth: () => async (_c: unknown, next: () => Promise<void>) => next(),
  requireApproved: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));
vi.mock('../../../src/services/jwt', async (load) => ({
  ...(await load<typeof import('../../../src/services/jwt')>()),
  shouldRefreshCallbackToken: () => false,
  verifyCallbackToken: vi.fn(async () => ({
    workspace: 'node-1',
    scope: 'node',
    type: 'callback',
  })),
}));
const databases: Database.Database[] = [];
afterEach(() => {
  databases.splice(0).forEach((db) => db.close());
  vi.restoreAllMocks();
});
const blockedSince = '2026-10-30T10:00:00.000Z';
function fixture(status = 'stopped') {
  const sqlite = new Database(':memory:');
  databases.push(sqlite);
  createAllSchemaTables(sqlite, schema);
  sqlite
    .prepare(
      `INSERT INTO nodes
    (id,user_id,name,status,health_status,node_class,node_role,runtime,created_at,updated_at,
     cleanup_blocked_since,cleanup_blocked_reason,cleanup_blocked_alerted_at,error_message)
    VALUES ('node-1','owner-1','Blocked VM',?,'healthy','managed','workspace','vm',?,?,?,
      'unproven_workspace_deletion',?,'Previous provider failure')`
    )
    .run(status, blockedSince, blockedSince, blockedSince, blockedSince);
  const env = { DATABASE: createSqliteD1(sqlite), BASE_DOMAIN: 'example.test' } as Env;
  const app = new Hono<{ Bindings: Env }>();
  app.onError((error, c) =>
    error instanceof AppError
      ? c.json(error.toJSON(), error.statusCode as never)
      : c.json({ error: error.message }, 500)
  );
  app.route('/api/nodes', nodeLifecycleRoutes);
  app.route('/api/nodes', nodesRoutes);
  return { sqlite, env, app };
}

describe('cleanup blocked state through real node HTTP routes', () => {
  it('clears the blocked clock, reason and alert marker when ready transitions to running', async () => {
    const f = fixture('creating');
    const pending: Promise<unknown>[] = [];
    const response = await f.app.request(
      '/api/nodes/node-1/ready',
      {
        method: 'POST',
        headers: { Authorization: 'Bearer callback-token', 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentVersion: 'agent-build-sha' }),
      },
      f.env,
      {
        waitUntil: (promise: Promise<unknown>) => pending.push(promise),
        passThroughOnException: vi.fn(),
      } as unknown as ExecutionContext
    );
    expect(response.status, JSON.stringify(await response.json())).toBe(200);
    await Promise.all(pending);
    expect(
      f.sqlite
        .prepare(
          `SELECT status,agent_version,cleanup_blocked_since,cleanup_blocked_reason,
      cleanup_blocked_alerted_at FROM nodes WHERE id='node-1'`
        )
        .get()
    ).toEqual({
      status: 'running',
      agent_version: 'agent-build-sha',
      cleanup_blocked_since: null,
      cleanup_blocked_reason: null,
      cleanup_blocked_alerted_at: null,
    });
  });

  it('retains the original blocked clock when a heartbeat only updates liveness', async () => {
    const f = fixture('creating');
    const pending: Promise<unknown>[] = [];
    const response = await f.app.request(
      '/api/nodes/node-1/heartbeat',
      {
        method: 'POST',
        headers: { Authorization: 'Bearer callback-token', 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentVersion: 'heartbeat-build-sha' }),
      },
      f.env,
      {
        waitUntil: (promise: Promise<unknown>) => pending.push(promise),
        passThroughOnException: vi.fn(),
      } as unknown as ExecutionContext
    );
    expect(response.status, JSON.stringify(await response.json())).toBe(200);
    await Promise.all(pending);
    expect(
      f.sqlite
        .prepare(
          `SELECT status,agent_version,cleanup_blocked_since,cleanup_blocked_reason,
      cleanup_blocked_alerted_at FROM nodes WHERE id='node-1'`
        )
        .get()
    ).toEqual({
      status: 'creating',
      agent_version: 'heartbeat-build-sha',
      cleanup_blocked_since: blockedSince,
      cleanup_blocked_reason: 'unproven_workspace_deletion',
      cleanup_blocked_alerted_at: blockedSince,
    });
    const timestamps = f.sqlite
      .prepare("SELECT updated_at,last_heartbeat_at FROM nodes WHERE id='node-1'")
      .get() as { updated_at: string; last_heartbeat_at: string };
    expect(timestamps.updated_at).not.toBe(blockedSince);
    expect(timestamps.last_heartbeat_at).toBe(timestamps.updated_at);
  });

  it('lists the blocked time and guard in the existing user-visible error message', async () => {
    const f = fixture();
    const response = await f.app.request('/api/nodes', {}, f.env);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([
      expect.objectContaining({
        id: 'node-1',
        cleanupBlockedSince: blockedSince,
        cleanupBlockedReason: 'unproven_workspace_deletion',
        errorMessage: `Cleanup blocked since ${blockedSince}: unproven_workspace_deletion`,
      }),
    ]);
  });

  it('retains the ordinary provider error when cleanup is no longer blocked', async () => {
    const f = fixture();
    f.sqlite.exec('UPDATE nodes SET cleanup_blocked_since=NULL, cleanup_blocked_reason=NULL');
    const response = await f.app.request('/api/nodes', {}, f.env);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([
      expect.objectContaining({
        id: 'node-1',
        cleanupBlockedSince: null,
        cleanupBlockedReason: null,
        errorMessage: 'Previous provider failure',
      }),
    ]);
  });
});
