import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ deleteNodeResourcesStrict: vi.fn() }));
vi.mock('../../../src/services/strict-node-deletion', () => mocks);

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { cleanupFreshProvisioningNode } from '../../../src/services/provisioning-authority';
import { createAllSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

let sqlite: Database.Database;
let database: D1Database;
const input = {
  nodeId: 'node-1',
  userId: 'user-1',
  nodeRole: 'workspace' as const,
  reason: 'failed allocation',
};

beforeEach(() => {
  vi.clearAllMocks();
  sqlite = new Database(':memory:');
  createAllSchemaTables(sqlite, schema);
  database = createSqliteD1(sqlite);
  sqlite.exec(`INSERT INTO nodes
    (id, user_id, name, status, runtime, node_class, node_role, provider_instance_id, runtime_incarnation_id)
    VALUES ('node-1', 'user-1', 'Fresh node', 'running', 'vm', 'managed', 'workspace', 'vm-1', 'incarnation-1')`);
  mocks.deleteNodeResourcesStrict.mockResolvedValue(undefined);
});

afterEach(() => sqlite.close());

/** Execute a concurrent writer after the initial eligibility read, before its caller resumes. */
function afterEligibilityRead(write: () => void): Env {
  let fired = false;
  return {
    DATABASE: {
      ...database,
      prepare: (sql: string) => {
        const statement = database.prepare(sql);
        return {
          ...statement,
          bind: (...params: unknown[]) => {
            const bound = statement.bind(...params);
            return {
              ...bound,
              first: async () => {
                const row = await bound.first();
                if (!fired) {
                  fired = true;
                  write();
                }
                return row;
              },
            };
          },
        };
      },
    },
  } as unknown as Env;
}

describe('fresh paid-node cleanup claim', () => {
  it('preserves a node when another workspace attaches after the eligibility read', async () => {
    const env = afterEligibilityRead(() => {
      sqlite.exec(`INSERT INTO workspaces (id, node_id, user_id, status)
        VALUES ('new-workspace', 'node-1', 'user-1', 'creating')`);
    });
    expect(await cleanupFreshProvisioningNode(env, input)).toBe('skipped');
    expect(mocks.deleteNodeResourcesStrict).not.toHaveBeenCalled();
    expect(sqlite.prepare('SELECT status FROM nodes').get()).toEqual({ status: 'running' });
  });

  it('preserves a node whose provider incarnation changes after the eligibility read', async () => {
    const env = afterEligibilityRead(() => {
      sqlite.exec(
        "UPDATE nodes SET runtime_incarnation_id = 'incarnation-2', provider_instance_id = 'vm-2'"
      );
    });
    expect(await cleanupFreshProvisioningNode(env, input)).toBe('skipped');
    expect(mocks.deleteNodeResourcesStrict).not.toHaveBeenCalled();
  });

  it('claims the same paid incarnation before strict deletion and fences later attachment', async () => {
    mocks.deleteNodeResourcesStrict.mockImplementationOnce(async () => {
      expect(sqlite.prepare('SELECT status FROM nodes').get()).toEqual({ status: 'destroying' });
      const attachment = sqlite
        .prepare(
          `INSERT INTO workspaces (id, node_id, user_id, status)
        SELECT 'late-workspace', id, user_id, 'creating' FROM nodes WHERE status = 'running'`
        )
        .run();
      expect(attachment.changes).toBe(0);
    });
    const env = { DATABASE: database } as unknown as Env;
    expect(await cleanupFreshProvisioningNode(env, input)).toBe('strict-deleted');
    expect(mocks.deleteNodeResourcesStrict).toHaveBeenCalledWith('node-1', 'user-1', env, {
      expectedRuntime: {
        userId: 'user-1',
        runtime: 'vm',
        providerInstanceId: 'vm-1',
        runtimeIncarnationId: 'incarnation-1',
      },
    });
  });

  it('retains the destroying row and provider identity when strict deletion fails', async () => {
    mocks.deleteNodeResourcesStrict.mockRejectedValueOnce(
      new Error('provider temporarily unavailable')
    );
    expect(
      await cleanupFreshProvisioningNode({ DATABASE: database } as unknown as Env, input)
    ).toBe('failed');
    expect(sqlite.prepare('SELECT status, provider_instance_id FROM nodes').get()).toEqual({
      status: 'destroying',
      provider_instance_id: 'vm-1',
    });
  });
});
