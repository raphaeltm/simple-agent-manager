import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/d1';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { destroyNodeForCleanup } from '../../../src/scheduled/node-cleanup/shared';
import { createSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

const mocks = vi.hoisted(() => ({
  deleteNodeResources: vi.fn(),
  persistError: vi.fn(),
}));

vi.mock('../../../src/services/nodes', () => ({
  deleteNodeResources: (...args: unknown[]) => mocks.deleteNodeResources(...args),
}));

vi.mock('../../../src/services/observability', () => ({
  persistError: (...args: unknown[]) => mocks.persistError(...args),
}));

let sqlite: Database.Database;
let env: Env;

beforeEach(() => {
  vi.clearAllMocks();
  sqlite = new Database(':memory:');
  createSchemaTables(sqlite, [schema.nodes, schema.workspaces, schema.tasks]);
  env = {
    DATABASE: createSqliteD1(sqlite),
    OBSERVABILITY_DATABASE: createSqliteD1(sqlite),
  } as unknown as Env;
});

afterEach(() => {
  sqlite.close();
});

describe('destroyNodeForCleanup claim protocol', () => {
  it('restores an error node to error when provider destruction fails after claim', async () => {
    const db = drizzle(env.DATABASE, { schema });
    await db.insert(schema.nodes).values({
      id: 'node-error-restore',
      userId: 'user-error-restore',
      name: 'node-error-restore',
      status: 'error',
      nodeRole: 'workspace',
      nodeClass: 'managed',
      runtime: 'vm',
    } as typeof schema.nodes.$inferInsert);
    mocks.deleteNodeResources.mockRejectedValueOnce(new Error('provider timeout'));

    const destroyed = await destroyNodeForCleanup(
      db,
      env,
      '2026-08-12T12:00:00.000Z',
      { id: 'node-error-restore', user_id: 'user-error-restore', status: 'error' },
      {
        logEvent: 'test.destroying_error_node',
        failureLogEvent: 'test.error_node_destroy_failed',
        successMessage: 'destroyed test node',
        failureMessagePrefix: 'failed test node',
        recoveryType: 'test_node_cleanup',
        failureRecoveryType: 'test_node_cleanup_failure',
        failureBackoffMs: 60_000,
        context: {},
      }
    );

    expect(destroyed).toBe(false);
    expect(mocks.deleteNodeResources).toHaveBeenCalledWith(
      'node-error-restore',
      'user-error-restore',
      env
    );
    const node = sqlite
      .prepare(`SELECT status, cleanup_backoff_until FROM nodes WHERE id = ?`)
      .get('node-error-restore') as { status: string; cleanup_backoff_until: string | null };
    expect(node.status).toBe('error');
    expect(node.cleanup_backoff_until).toBe('2026-08-12T12:01:00.000Z');
  });

  it('does not call the provider after a sibling active workspace appears before node claim', async () => {
    const db = drizzle(env.DATABASE, { schema });
    await db.insert(schema.nodes).values({
      id: 'node-active-sibling',
      userId: 'user-active-sibling',
      name: 'node-active-sibling',
      status: 'running',
      nodeRole: 'workspace',
      nodeClass: 'managed',
      runtime: 'vm',
    } as typeof schema.nodes.$inferInsert);
    await db.insert(schema.workspaces).values({
      id: 'ws-active-sibling',
      nodeId: 'node-active-sibling',
      userId: 'user-active-sibling',
      projectId: 'project-active-sibling',
      name: 'ws-active-sibling',
      repository: 'org/repo',
      vmSize: 'small',
      vmLocation: 'nbg1',
      status: 'pending',
    } as typeof schema.workspaces.$inferInsert);

    const destroyed = await destroyNodeForCleanup(
      db,
      env,
      '2026-08-12T12:00:00.000Z',
      { id: 'node-active-sibling', user_id: 'user-active-sibling', status: 'running' },
      {
        logEvent: 'test.destroying_active_sibling',
        failureLogEvent: 'test.active_sibling_destroy_failed',
        successMessage: 'destroyed test node',
        failureMessagePrefix: 'failed test node',
        recoveryType: 'test_node_cleanup',
        failureRecoveryType: 'test_node_cleanup_failure',
        failureBackoffMs: 60_000,
        context: {},
      }
    );

    expect(destroyed).toBe(false);
    expect(mocks.deleteNodeResources).not.toHaveBeenCalled();
    const node = sqlite
      .prepare(`SELECT status FROM nodes WHERE id = ?`)
      .get('node-active-sibling') as { status: string };
    expect(node.status).toBe('running');
  });
});
