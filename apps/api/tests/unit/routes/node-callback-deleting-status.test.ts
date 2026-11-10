/**
 * Node callbacks from a deployment node in `deleting` (state-machine audit D5).
 *
 * `deleting` is written when a deployment node's last environment is deleted and only
 * moves on to `deleted` or `error`. It was missing from NODE_CALLBACK_TERMINAL_STATUSES,
 * so `/ready` could set such a node back to `running` and heartbeats kept refreshing its
 * callback token. These tests drive the real routes with a real callback JWT against a
 * real SQLite engine (rules 28 and 62); the `/ready` race injects the deletion after the
 * handler's first read of the node so the write predicate itself is exercised.
 */
import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { exportPKCS8, exportSPKI, generateKeyPair } from 'jose';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { AppError } from '../../../src/middleware/error';
import { nodeLifecycleRoutes } from '../../../src/routes/node-lifecycle';
import { signNodeCallbackToken } from '../../../src/services/jwt';
import { createRacingD1 } from '../../helpers/racing-d1';
import { createAllSchemaTables, createMemoryKv } from '../../helpers/sqlite-d1';

vi.mock('../../../src/services/vm-admission-control', () => ({
  wakeVmAdmissionWaiters: vi.fn(async () => undefined),
}));
vi.mock('../../../src/services/project-data', () => ({}));

const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true });
const [JWT_PRIVATE_KEY, JWT_PUBLIC_KEY] = await Promise.all([
  exportPKCS8(privateKey),
  exportSPKI(publicKey),
]);

const NODE_ID = 'node-deploy-1';

let sqlite: Database.Database;
let afterFirstNodeRead: (() => void) | null;

function racingD1(): D1Database {
  const race = createRacingD1(sqlite, 'nodes');
  const hook = afterFirstNodeRead;
  if (hook) {
    race.afterNextRead(() => {
      afterFirstNodeRead = null;
      hook();
    });
  }
  return race.d1;
}

function buildEnv(overrides: Record<string, string> = {}): Env {
  return {
    DATABASE: racingD1(),
    KV: createMemoryKv(),
    JWT_PRIVATE_KEY,
    JWT_PUBLIC_KEY,
    BASE_DOMAIN: 'example.com',
    ...overrides,
  } as unknown as Env;
}

/** A callback token already past its refresh point (10s lifetime, refresh at 10%). */
const REFRESH_DUE_ENV = {
  CALLBACK_TOKEN_EXPIRY_MS: '10000',
  CALLBACK_TOKEN_REFRESH_THRESHOLD_RATIO: '0.1',
};

async function refreshDueToken(env: Env): Promise<string> {
  const token = await signNodeCallbackToken(NODE_ID, env, { callbackGeneration: null });
  await new Promise((resolve) => setTimeout(resolve, 1100));
  return token;
}

function buildApp(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();
  app.onError((err, c) => {
    if (err instanceof AppError) {
      return c.json({ error: err.error, message: err.message }, err.statusCode as 400);
    }
    throw err;
  });
  app.route('/api/nodes', nodeLifecycleRoutes);
  return app;
}

function seedNode(status: string): void {
  sqlite
    .prepare(
      `INSERT INTO nodes (id, user_id, name, status, node_role, health_status)
       VALUES (?, 'user-1', 'deploy-node', ?, 'deployment', 'healthy')`
    )
    .run(NODE_ID, status);
}

function nodeStatus(): string {
  return (
    sqlite.prepare('SELECT status FROM nodes WHERE id = ?').get(NODE_ID) as {
      status: string;
    }
  ).status;
}

async function callback(
  env: Env,
  path: 'ready' | 'heartbeat',
  body?: unknown,
  presetToken?: string
) {
  const token =
    presetToken ?? (await signNodeCallbackToken(NODE_ID, env, { callbackGeneration: null }));
  return buildApp().request(
    `/api/nodes/${NODE_ID}/${path}`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    },
    env,
    { waitUntil: () => undefined, passThroughOnException: () => undefined } as never
  );
}

describe('node callbacks from a deleting deployment node', () => {
  beforeEach(() => {
    sqlite = new Database(':memory:');
    createAllSchemaTables(sqlite, schema);
    afterFirstNodeRead = null;
  });

  it('/ready moves a creating node to running (control)', async () => {
    seedNode('creating');
    const res = await callback(buildEnv(), 'ready');
    expect(res.status).toBe(200);
    expect(nodeStatus()).toBe('running');
  });

  it('/ready answers 410 and leaves a deleting node deleting', async () => {
    seedNode('deleting');
    const res = await callback(buildEnv(), 'ready');
    expect(res.status).toBe(410);
    expect(nodeStatus()).toBe('deleting');
  });

  it('/ready does not revive a node that turns deleting after the handler read it', async () => {
    seedNode('creating');
    afterFirstNodeRead = () => {
      sqlite.prepare(`UPDATE nodes SET status = 'deleting' WHERE id = ?`).run(NODE_ID);
    };
    const res = await callback(buildEnv(), 'ready');
    expect(afterFirstNodeRead).toBeNull(); // the race was actually injected
    expect(res.status).toBe(410);
    expect(nodeStatus()).toBe('deleting');
  });

  it('heartbeat refreshes a due token for a running node (control)', async () => {
    seedNode('running');
    const env = buildEnv(REFRESH_DUE_ENV);
    const res = await callback(env, 'heartbeat', {}, await refreshDueToken(env));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(typeof body.refreshedToken).toBe('string');
  });

  it('heartbeat answers 410 for a deleting node and refreshes no token', async () => {
    seedNode('deleting');
    const env = buildEnv(REFRESH_DUE_ENV);
    const res = await callback(env, 'heartbeat', {}, await refreshDueToken(env));
    expect(res.status).toBe(410);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.refreshedToken).toBeUndefined();
    expect(nodeStatus()).toBe('deleting');
  });

  it('heartbeat does not revive a node that turns deleting after the handler read it', async () => {
    seedNode('running');
    afterFirstNodeRead = () => {
      sqlite.prepare(`UPDATE nodes SET status = 'deleting' WHERE id = ?`).run(NODE_ID);
    };
    const env = buildEnv(REFRESH_DUE_ENV);
    const res = await callback(env, 'heartbeat', {}, await refreshDueToken(env));
    expect(afterFirstNodeRead).toBeNull(); // the race was actually injected
    expect(res.status).toBe(410);
    expect(nodeStatus()).toBe('deleting');
  });
});
