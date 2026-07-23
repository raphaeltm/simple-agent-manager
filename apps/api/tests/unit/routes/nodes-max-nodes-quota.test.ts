/**
 * MAX_NODES_PER_USER must exclude user-owned (BYO) nodes (architecture-critique #8, PR-0C).
 *
 * Behavioral test of the real POST /api/nodes quota gate against a faithful in-memory D1. The gate
 * runs BEFORE credential resolution, so we distinguish "quota passed" (reaches the mocked
 * resolveCredentialSource → 403 credentials-required) from "quota blocked" (→ 400 Maximum nodes).
 * With the limit at 2 and 2 user-owned nodes seeded, the request must PASS the quota (403); with 2
 * managed nodes it must be BLOCKED (400) — the managed case is the discriminating control.
 */
import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AppError } from '../../../src/middleware/error';
import { createSqliteD1 } from '../../helpers/sqlite-d1';

vi.mock('../../../src/middleware/auth', () => ({
  getUserId: () => 'user-1',
  requireAuth: () => async (_c: unknown, next: () => Promise<void>) => next(),
  requireApproved: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));

// Credential resolution runs AFTER the quota gate; returning null makes a quota-passing request
// fail closed at 403, which is exactly the signal we use to detect "the quota did not block".
vi.mock('../../../src/services/provider-credentials', () => ({
  resolveCredentialSource: vi.fn().mockResolvedValue(null),
  createProviderForUser: vi.fn().mockResolvedValue(null),
}));

vi.mock('../../../src/lib/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  serializeError: (e: unknown) => ({ error: String(e) }),
  createModuleLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

let sqlite: Database.Database | null = null;

function seedNode(id: string, nodeClass: 'managed' | 'user-owned'): void {
  sqlite
    ?.prepare(
      `INSERT INTO nodes (id, user_id, name, status, node_role, node_class, created_at, updated_at)
       VALUES (?, 'user-1', ?, 'running', 'workspace', ?, '2020-01-01', '2020-01-01')`
    )
    .run(id, `node-${id}`, nodeClass);
}

async function postNode(): Promise<Response> {
  const { nodesRoutes } = await import('../../../src/routes/nodes');
  const app = new Hono();
  app.route('/api/nodes', nodesRoutes);
  app.onError((err, c) => {
    if (err instanceof AppError) {
      return c.json(err.toJSON(), err.statusCode as 400 | 401 | 403 | 404 | 500);
    }
    return c.json({ error: 'INTERNAL_ERROR', message: String(err) }, 500);
  });
  return app.request(
    '/api/nodes',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'new-node' }),
    },
    { DATABASE: createSqliteD1(sqlite as Database.Database), MAX_NODES_PER_USER: '2' }
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  sqlite = new Database(':memory:');
  sqlite.exec(`
    CREATE TABLE nodes (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL, status TEXT NOT NULL,
      node_role TEXT NOT NULL DEFAULT 'workspace', node_class TEXT NOT NULL DEFAULT 'managed',
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
  `);
});

describe('POST /api/nodes MAX_NODES_PER_USER excludes user-owned nodes', () => {
  it('does NOT count user-owned nodes toward the quota (2 BYO nodes at limit=2 still passes the gate)', async () => {
    seedNode('byo-1', 'user-owned');
    seedNode('byo-2', 'user-owned');

    const res = await postNode();

    // Passed the quota gate (reached credential resolution) rather than 400 "Maximum nodes".
    expect(res.status).toBe(403);
    expect(await res.text()).not.toContain('Maximum');
  });

  it('DOES count managed nodes toward the quota (2 managed nodes at limit=2 is blocked)', async () => {
    seedNode('managed-1', 'managed');
    seedNode('managed-2', 'managed');

    const res = await postNode();

    expect(res.status).toBe(400);
    expect(await res.text()).toContain('Maximum');
  });
});
