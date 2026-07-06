/**
 * Unit tests for node cleanup cron sweep — activity-aware lifecycle.
 *
 * Verifies:
 * 1. Layer 3 max lifetime skips nodes with active workspaces (no absolute ceiling)
 * 2. Nodes without active workspaces are destroyed normally
 */
import { beforeEach,describe, expect, it, vi } from 'vitest';

import type { Env } from '../../src/env';
import { runNodeCleanupSweep } from '../../src/scheduled/node-cleanup';

// Mock deleteNodeResources
vi.mock('../../src/services/nodes', () => ({
  deleteNodeResources: vi.fn().mockResolvedValue(undefined),
}));

// Mock node-agent service
vi.mock('../../src/services/node-agent', () => ({
  deleteWorkspaceOnNode: vi.fn().mockResolvedValue(undefined),
  stopWorkspaceOnNode: vi.fn().mockResolvedValue(undefined),
}));

// Mock project-data service
vi.mock('../../src/services/project-data', () => ({
  stopSession: vi.fn().mockResolvedValue(undefined),
  cleanupWorkspaceActivity: vi.fn().mockResolvedValue(undefined),
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
      if (sql.includes("WHERE n.status = 'stopped'")) {
        return mockPreparedStatement(prepareResponses.get("WHERE n.status = 'stopped'") ?? []);
      }
      const orderedResponses = Array.from(prepareResponses.entries()).sort(
        ([left], [right]) => right.length - left.length,
      );
      for (const [substring, results] of orderedResponses) {
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

    it('always skips nodes with active workspaces (no absolute ceiling)', async () => {
      const now = Date.now();
      // Node created 13 hours ago — would have been destroyed by old absolute ceiling,
      // but now nodes with active workspaces are always skipped.
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

      expect(result.lifetimeSkipped).toBe(1);
      expect(result.lifetimeDestroyed).toBe(0);
    });
  });

  describe('Layer 1: stale warm node destruction', () => {
    it('destroys stale warm nodes with no active workspaces', async () => {
      const { deleteNodeResources } = await import('../../src/services/nodes');
      const now = Date.now();
      const warmSince = new Date(now - 40 * 60 * 1000).toISOString(); // 40 min ago (> 35 min grace)

      const responses = new Map<string, unknown[]>();
      // Layer 1: one stale warm node with 0 running workspaces
      responses.set('n.warm_since IS NOT NULL', [
        {
          id: 'node-warm',
          user_id: 'user-1',
          warm_since: warmSince,
          running_ws_count: 0,
        },
      ]);
      // Layer 3: no auto-provisioned nodes past lifetime
      responses.set('auto_provisioned_node_id', []);
      // Orphan checks: empty
      responses.set("t.status IN ('completed', 'failed', 'cancelled')", []);
      responses.set('n.warm_since IS NULL', []);

      const env = createMockEnv(responses);
      const result = await runNodeCleanupSweep(env);

      expect(result.staleDestroyed).toBe(1);
      expect(deleteNodeResources).toHaveBeenCalledWith('node-warm', 'user-1', env);
    });

    it('skips stale warm nodes that have active workspaces', async () => {
      const now = Date.now();
      const warmSince = new Date(now - 40 * 60 * 1000).toISOString();

      const responses = new Map<string, unknown[]>();
      responses.set('n.warm_since IS NOT NULL', [
        {
          id: 'node-warm',
          user_id: 'user-1',
          warm_since: warmSince,
          running_ws_count: 1,
        },
      ]);
      responses.set('auto_provisioned_node_id', []);
      responses.set("t.status IN ('completed', 'failed', 'cancelled')", []);
      responses.set('n.warm_since IS NULL', []);

      const env = createMockEnv(responses);
      const result = await runNodeCleanupSweep(env);

      expect(result.staleDestroyed).toBe(0);
    });
  });

  describe('DO alarm handoff cleanup', () => {
    it('destroys stopped auto-provisioned nodes left behind by the NodeLifecycle alarm', async () => {
      const { deleteNodeResources } = await import('../../src/services/nodes');
      const now = Date.now();
      const createdAt = new Date(now - 2 * 60 * 60 * 1000).toISOString();
      const updatedAt = new Date(now - 30 * 60 * 1000).toISOString();

      const responses = new Map<string, unknown[]>();
      responses.set('n.warm_since IS NOT NULL', []);
      responses.set('auto_provisioned_node_id', []);
      responses.set("t.status IN ('completed', 'failed', 'cancelled')", []);
      responses.set('n.warm_since IS NULL', []);
      responses.set("WHERE n.status = 'stopped'", [
        {
          id: 'node-stopped-handoff',
          user_id: 'user-1',
          status: 'stopped',
          created_at: createdAt,
          updated_at: updatedAt,
          active_ws_count: 0,
        },
      ]);

      const env = createMockEnv(responses);
      const result = await runNodeCleanupSweep(env);

      expect(result.lifetimeDestroyed).toBe(1);
      expect(deleteNodeResources).toHaveBeenCalledWith('node-stopped-handoff', 'user-1', env);
    });

    it('does not destroy stopped handoff nodes with active workspaces', async () => {
      const { deleteNodeResources } = await import('../../src/services/nodes');
      const updatedAt = new Date(Date.now() - 30 * 60 * 1000).toISOString();

      const responses = new Map<string, unknown[]>();
      responses.set('n.warm_since IS NOT NULL', []);
      responses.set('auto_provisioned_node_id', []);
      responses.set("t.status IN ('completed', 'failed', 'cancelled')", []);
      responses.set('n.warm_since IS NULL', []);
      responses.set("WHERE n.status = 'stopped'", [
        {
          id: 'node-stopped-active',
          user_id: 'user-1',
          status: 'stopped',
          updated_at: updatedAt,
          active_ws_count: 1,
        },
      ]);

      const env = createMockEnv(responses);
      const result = await runNodeCleanupSweep(env);

      expect(result.lifetimeDestroyed).toBe(0);
      expect(result.lifetimeSkipped).toBe(1);
      expect(deleteNodeResources).not.toHaveBeenCalledWith('node-stopped-active', 'user-1', env);
    });
  });

  describe('orphaned task workspace cleanup', () => {
    it('stops terminal task workspaces in recovery so they stop counting as active forever', async () => {
      const { stopWorkspaceOnNode } = await import('../../src/services/node-agent');
      const createdAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();

      const responses = new Map<string, unknown[]>();
      responses.set('n.warm_since IS NOT NULL', []);
      responses.set('auto_provisioned_node_id', []);
      responses.set("WHERE n.status = 'stopped'", []);
      responses.set("w.status IN ('running', 'creating', 'recovery')", [
        {
          id: 'ws-recovery-orphan',
          node_id: 'node-recovery-orphan',
          user_id: 'user-1',
          status: 'recovery',
          created_at: createdAt,
          project_id: null,
          chat_session_id: null,
        },
      ]);
      responses.set('n.warm_since IS NULL', []);

      const env = createMockEnv(responses);
      const result = await runNodeCleanupSweep(env);

      expect(result.orphanedWorkspacesFlagged).toBe(1);
      expect(stopWorkspaceOnNode).toHaveBeenCalledWith(
        'node-recovery-orphan',
        'ws-recovery-orphan',
        env,
        'user-1',
      );
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
        orphanedWorkspacesFlagged: 0,
        orphanedNodesFlagged: 0,
        stoppedWorkspacesDeleted: 0,
        errors: 0,
      });
    });
  });
});
