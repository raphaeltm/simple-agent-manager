import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { AppError } from '../../../src/middleware/error';
import { lifecycleRoutes } from '../../../src/routes/workspaces/lifecycle';
import { createSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

const USER = 'user-lifecycle';

const mocks = vi.hoisted(() => ({
  restartWorkspaceOnNode: vi.fn(),
  rebuildWorkspaceOnNode: vi.fn(),
  writeBootLogs: vi.fn(),
  cancelWorkspaceDeletion: vi.fn(),
  waitUntil: vi.fn(),
}));

vi.mock('../../../src/middleware/auth', () => ({
  requireAuth: () => vi.fn((_c: unknown, next: () => Promise<void>) => next()),
  requireApproved: () => vi.fn((_c: unknown, next: () => Promise<void>) => next()),
  getUserId: () => USER,
}));

vi.mock('../../../src/services/node-agent', () => ({
  restartWorkspaceOnNode: (...args: unknown[]) => mocks.restartWorkspaceOnNode(...args),
  rebuildWorkspaceOnNode: (...args: unknown[]) => mocks.rebuildWorkspaceOnNode(...args),
  stopWorkspaceOnNode: vi.fn(),
}));

vi.mock('../../../src/services/boot-log', () => ({
  writeBootLogs: (...args: unknown[]) => mocks.writeBootLogs(...args),
}));

vi.mock('../../../src/services/project-data', () => ({
  recordActivityEvent: vi.fn(),
}));

let sqlite: Database.Database;
let baseD1: D1Database;
let env: Env;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.writeBootLogs.mockResolvedValue(undefined);
  mocks.cancelWorkspaceDeletion.mockResolvedValue(undefined);
  mocks.restartWorkspaceOnNode.mockResolvedValue(undefined);
  mocks.rebuildWorkspaceOnNode.mockResolvedValue(undefined);

  sqlite = new Database(':memory:');
  createSchemaTables(sqlite, [schema.nodes, schema.workspaces]);
  baseD1 = createSqliteD1(sqlite);
  env = {
    DATABASE: baseD1,
    KV: {} as KVNamespace,
    NODE_LIFECYCLE: {
      idFromName: (id: string) => id,
      get: () => ({ cancelWorkspaceDeletion: mocks.cancelWorkspaceDeletion }),
    },
  } as unknown as Env;
});

afterEach(() => {
  sqlite.close();
});

function db() {
  return drizzle(env.DATABASE, { schema });
}

function app() {
  const hono = new Hono<{ Bindings: Env }>();
  hono.route('/api/workspaces', lifecycleRoutes);
  hono.onError((err, c) =>
    err instanceof AppError
      ? c.json(err.toJSON(), err.statusCode as never)
      : c.json({ error: 'INTERNAL_ERROR', message: err instanceof Error ? err.message : String(err) }, 500)
  );
  return hono;
}

async function seedWorkspace(status: string): Promise<void> {
  await db().insert(schema.nodes).values({
    id: 'node-lifecycle',
    userId: USER,
    name: 'node-lifecycle',
    status: 'running',
    healthStatus: 'healthy',
    runtime: 'vm',
    nodeRole: 'workspace',
    nodeClass: 'managed',
  } as typeof schema.nodes.$inferInsert);
  await db().insert(schema.workspaces).values({
    id: 'ws-lifecycle',
    nodeId: 'node-lifecycle',
    userId: USER,
    projectId: null,
    name: 'ws-lifecycle',
    repository: 'org/repo',
    vmSize: 'small',
    vmLocation: 'nbg1',
    status,
  } as typeof schema.workspaces.$inferInsert);
}

function injectWorkspaceClaimConflict(nextStatus: 'stopping' | 'running'): void {
  env = {
    ...env,
    DATABASE: {
      ...baseD1,
      prepare: (sql: string) => {
        if (
          sql.includes('update "workspaces"') &&
          sql.includes('"status" = ?') &&
          sql.includes('returning "id"')
        ) {
          return {
            bind: () => ({
              run: async () => ({ success: true, results: [], meta: { changes: 0 } }),
              all: async () => {
                sqlite
                  .prepare(`UPDATE workspaces SET status = ? WHERE id = ?`)
                  .run(nextStatus, 'ws-lifecycle');
                return { success: true, results: [], meta: {} };
              },
              raw: async () => [],
              first: async () => null,
            }),
          } as unknown as D1PreparedStatement;
        }
        return baseD1.prepare(sql);
      },
    } as D1Database,
  } as Env;
}

async function post(path: string): Promise<Response> {
  return app().request(path, { method: 'POST' }, env, {
    waitUntil: (promise: Promise<unknown>) => mocks.waitUntil(promise),
  });
}

describe('workspace restart/rebuild CAS', () => {
  it('ATTACK: restart returns conflict and does not call VM when status changes before claim', async () => {
    await seedWorkspace('stopped');
    injectWorkspaceClaimConflict('stopping');

    const response = await post('/api/workspaces/ws-lifecycle/restart');

    expect(response.status).toBe(409);
    expect(mocks.restartWorkspaceOnNode).not.toHaveBeenCalled();
    expect(mocks.writeBootLogs).not.toHaveBeenCalled();
    expect(mocks.waitUntil).not.toHaveBeenCalled();
  });

  it('ATTACK: rebuild returns conflict and does not call VM when status changes before claim', async () => {
    await seedWorkspace('running');
    injectWorkspaceClaimConflict('stopping');

    const response = await post('/api/workspaces/ws-lifecycle/rebuild');

    expect(response.status).toBe(409);
    expect(mocks.rebuildWorkspaceOnNode).not.toHaveBeenCalled();
    expect(mocks.writeBootLogs).not.toHaveBeenCalled();
    expect(mocks.waitUntil).not.toHaveBeenCalled();
  });

  it('CONTROL: restart claims the stopped workspace before scheduling VM restart', async () => {
    await seedWorkspace('stopped');

    const response = await post('/api/workspaces/ws-lifecycle/restart');

    expect(response.status).toBe(200);
    expect(mocks.writeBootLogs).toHaveBeenCalledWith(env.KV, 'ws-lifecycle', [], env);
    expect(mocks.waitUntil).toHaveBeenCalledTimes(1);
    const workspace = sqlite
      .prepare(`SELECT status, error_message FROM workspaces WHERE id = ?`)
      .get('ws-lifecycle') as { status: string; error_message: string | null };
    expect(workspace.status).toBe('creating');
    expect(workspace.error_message).toBeNull();
  });

  it('CONTROL: rebuild claims the running workspace before scheduling VM rebuild', async () => {
    await seedWorkspace('running');

    const response = await post('/api/workspaces/ws-lifecycle/rebuild');

    expect(response.status).toBe(202);
    expect(mocks.writeBootLogs).toHaveBeenCalledWith(env.KV, 'ws-lifecycle', [], env);
    expect(mocks.waitUntil).toHaveBeenCalledTimes(1);
    const workspace = sqlite
      .prepare(`SELECT status, error_message FROM workspaces WHERE id = ?`)
      .get('ws-lifecycle') as { status: string; error_message: string | null };
    expect(workspace.status).toBe('creating');
    expect(workspace.error_message).toBeNull();
  });
});
