/**
 * Unit tests for node cleanup cron sweep — activity-aware lifecycle.
 *
 * Verifies:
 * 1. Layer 3 max lifetime skips nodes with active workspaces
 * 2. Absolute ceiling destroys nodes regardless of active workspaces
 * 3. Nodes without active workspaces are destroyed normally
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { runNodeCleanupSweep } from '../../src/scheduled/node-cleanup';
import type { Env } from '../../src/index';

// Mock deleteNodeResources
vi.mock('../../src/services/nodes', () => ({
  deleteNodeResources: vi.fn().mockResolvedValue(undefined),
}));

// Mock persistError
vi.mock('../../src/services/observability', () => ({
  persistError: vi.fn().mockResolvedValue(undefined),
}));

// Mock logger
vi.mock('../../src/lib/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

/**
 * Create a mock D1 prepared statement that returns the given results.
 */
function mockPreparedStatement(results: unknown[] = []) {
  return {
    bind: vi.fn().mockReturnValue({
      all: vi.fn().mockResolvedValue({ results }),
      first: vi.fn().mockResolvedValue(results[0] ?? null),
      run: vi.fn().mockResolvedValue({ meta: { changes: 1 } }),
    }),
    all: vi.fn().mockResolvedValue({ results }),
    first: vi.fn().mockResolvedValue(results[0] ?? null),
    run: vi.fn().mockResolvedValue({ meta: { changes: 1 } }),
  };
}

/**
 * Create a minimal mock Env with D1 database stubs.
 * The `prepareResponses` map lets you configure SQL query responses by substring match.
 */
function createMockEnv(prepareResponses: Map<string, unknown[]> = new Map()): Env {
  const mockDb = {
    prepare: vi.fn((sql: string) => {
      for (const [substring, results] of prepareResponses.entries()) {
        if (sql.includes(substring)) {
          return mockPreparedStatement(results);
        }
      }
      return mockPreparedStatement([]);
    }),
    // Drizzle ORM calls — redirect to prepare
    batch: vi.fn().mockResolvedValue([]),
    dump: vi.fn(),
    exec: vi.fn(),
  } as unknown as D1Database;

  return {
    DATABASE: mockDb,
    OBSERVABILITY_DATABASE: {
      prepare: vi.fn().mockReturnValue(mockPreparedStatement()),
    } as unknown as D1Database,
    NODE_WARM_GRACE_PERIOD_MS: '2100000', // 35 min
    MAX_AUTO_NODE_LIFETIME_MS: '14400000', // 4 hours
    ABSOLUTE_MAX_NODE_LIFETIME_MS: '43200000', // 12 hours
  } as unknown as Env;
}

describe('runNodeCleanupSweep', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Layer 3: max lifetime with active workspace check', () => {
    it('skips nodes with active workspaces below absolute ceiling', async () => {
      const now = Date.now();
      // Node created 5 hours ago (past 4h max, but below 12h absolute)
      const createdAt = new Date(now - 5 * 60 * 60 * 1000).toISOString();

      const responses = new Map<string, unknown[]>();
      // Layer 1: no stale warm nodes
      responses.set('n.warm_since IS NOT NULL', []);
      // Layer 2: one auto-provisioned node with 1 active workspace
      responses.set('auto_provisioned_node_id', [
        {
          node_id: 'node-1',
          id: 'node-1',
          user_id: 'user-1',
          status: 'running',
          created_at: createdAt,
          active_ws_count: 1,
        },
      ]);
      // Orphan checks: empty
      responses.set('w.status = \'running\'', []);
      responses.set('n.warm_since IS NULL', []);

      const env = createMockEnv(responses);
      const result = await runNodeCleanupSweep(env);

      expect(result.lifetimeSkipped).toBe(1);
      expect(result.lifetimeDestroyed).toBe(0);
      expect(result.absoluteLifetimeDestroyed).toBe(0);
    });

    it('destroys nodes without active workspaces past max lifetime', async () => {
      const { deleteNodeResources } = await import('../../src/services/nodes');
      const now = Date.now();
      const createdAt = new Date(now - 5 * 60 * 60 * 1000).toISOString();

      const responses = new Map<string, unknown[]>();
      responses.set('n.warm_since IS NOT NULL', []);
      responses.set('auto_provisioned_node_id', [
        {
          node_id: 'node-1',
          id: 'node-1',
          user_id: 'user-1',
          status: 'running',
          created_at: createdAt,
          active_ws_count: 0,
        },
      ]);
      responses.set('w.status = \'running\'', []);
      responses.set('n.warm_since IS NULL', []);

      const env = createMockEnv(responses);
      const result = await runNodeCleanupSweep(env);

      expect(result.lifetimeDestroyed).toBe(1);
      expect(result.lifetimeSkipped).toBe(0);
      expect(deleteNodeResources).toHaveBeenCalledWith('node-1', 'user-1', env);
    });

    it('destroys nodes past absolute ceiling even with active workspaces', async () => {
      const { deleteNodeResources } = await import('../../src/services/nodes');
      const now = Date.now();
      // Node created 13 hours ago (past 12h absolute ceiling)
      const createdAt = new Date(now - 13 * 60 * 60 * 1000).toISOString();

      const responses = new Map<string, unknown[]>();
      responses.set('n.warm_since IS NOT NULL', []);
      responses.set('auto_provisioned_node_id', [
        {
          node_id: 'node-1',
          id: 'node-1',
          user_id: 'user-1',
          status: 'running',
          created_at: createdAt,
          active_ws_count: 2,
        },
      ]);
      responses.set('w.status = \'running\'', []);
      responses.set('n.warm_since IS NULL', []);

      const env = createMockEnv(responses);
      const result = await runNodeCleanupSweep(env);

      expect(result.absoluteLifetimeDestroyed).toBe(1);
      expect(result.lifetimeSkipped).toBe(0);
      expect(deleteNodeResources).toHaveBeenCalledWith('node-1', 'user-1', env);
    });
  });

  describe('result structure', () => {
    it('returns all expected counters', async () => {
      const env = createMockEnv(new Map());
      const result = await runNodeCleanupSweep(env);

      expect(result).toEqual({
        staleDestroyed: 0,
        lifetimeDestroyed: 0,
        lifetimeSkipped: 0,
        absoluteLifetimeDestroyed: 0,
        orphanedWorkspacesFlagged: 0,
        orphanedNodesFlagged: 0,
        errors: 0,
      });
    });
  });
});
