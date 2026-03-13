/**
 * Unit tests for stuck task recovery — heartbeat-aware lifecycle.
 *
 * Verifies:
 * 1. In-progress tasks with recent heartbeats are NOT marked as stuck
 * 2. In-progress tasks with stale heartbeats ARE marked as stuck
 * 3. Tasks without a node are treated as stuck (no heartbeat to check)
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { recoverStuckTasks } from '../../src/scheduled/stuck-tasks';
import type { Env } from '../../src/index';

// Mock cleanupTaskRun
vi.mock('../../src/services/task-runner', () => ({
  cleanupTaskRun: vi.fn().mockResolvedValue(undefined),
}));

// Mock persistError
vi.mock('../../src/services/observability', () => ({
  persistError: vi.fn().mockResolvedValue(undefined),
}));

// Mock logger
vi.mock('../../src/lib/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Mock ulid
vi.mock('../../src/lib/ulid', () => ({
  ulid: vi.fn().mockReturnValue('test-ulid'),
}));

function mockPreparedStatement(results: unknown[] = [], changes = 1) {
  return {
    bind: vi.fn().mockReturnValue({
      all: vi.fn().mockResolvedValue({ results }),
      first: vi.fn().mockImplementation(() => Promise.resolve(results[0] ?? null)),
      run: vi.fn().mockResolvedValue({ meta: { changes } }),
    }),
    all: vi.fn().mockResolvedValue({ results }),
    first: vi.fn().mockResolvedValue(results[0] ?? null),
    run: vi.fn().mockResolvedValue({ meta: { changes } }),
  };
}

function createMockEnv(prepareResponses: Map<string, { results: unknown[]; changes?: number }> = new Map()): Env {
  const mockDb = {
    prepare: vi.fn((sql: string) => {
      for (const [substring, config] of prepareResponses.entries()) {
        if (sql.includes(substring)) {
          return mockPreparedStatement(config.results, config.changes ?? 1);
        }
      }
      return mockPreparedStatement([]);
    }),
    batch: vi.fn().mockResolvedValue([]),
    dump: vi.fn(),
    exec: vi.fn(),
  } as unknown as D1Database;

  const mockTaskRunnerDO = {
    idFromName: vi.fn().mockReturnValue({ toString: () => 'do-id' }),
    get: vi.fn().mockReturnValue({
      getStatus: vi.fn().mockResolvedValue(null),
    }),
  };

  return {
    DATABASE: mockDb,
    OBSERVABILITY_DATABASE: {
      prepare: vi.fn().mockReturnValue(mockPreparedStatement()),
    } as unknown as D1Database,
    TASK_RUN_MAX_EXECUTION_MS: '14400000', // 4 hours
    TASK_STUCK_QUEUED_TIMEOUT_MS: '600000', // 10 min
    TASK_STUCK_DELEGATED_TIMEOUT_MS: '1860000', // 31 min
    NODE_HEARTBEAT_STALE_SECONDS: '180', // 3 min
    TASK_RUNNER: mockTaskRunnerDO,
  } as unknown as Env;
}

describe('recoverStuckTasks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('heartbeat-aware in_progress recovery', () => {
    it('skips in_progress tasks when node heartbeat is recent', async () => {
      const now = Date.now();
      // Task started 5 hours ago (past 4h limit)
      const startedAt = new Date(now - 5 * 60 * 60 * 1000).toISOString();
      const updatedAt = new Date(now - 5 * 60 * 60 * 1000).toISOString();
      // Heartbeat 30 seconds ago (recent)
      const recentHeartbeat = new Date(now - 30 * 1000).toISOString();

      const responses = new Map<string, { results: unknown[]; changes?: number }>();
      // Query to find stuck tasks
      responses.set('status IN (\'queued\', \'delegated\', \'in_progress\')', {
        results: [
          {
            id: 'task-1',
            project_id: 'proj-1',
            user_id: 'user-1',
            status: 'in_progress',
            execution_step: 'running',
            updated_at: updatedAt,
            started_at: startedAt,
            workspace_id: 'ws-1',
            auto_provisioned_node_id: 'node-1',
          },
        ],
      });
      // Workspace lookup for node_id
      responses.set('node_id FROM workspaces', {
        results: [{ node_id: 'node-1' }],
      });
      // Heartbeat check — recent
      responses.set('last_heartbeat_at FROM nodes', {
        results: [{ last_heartbeat_at: recentHeartbeat }],
      });

      const env = createMockEnv(responses);
      const result = await recoverStuckTasks(env);

      expect(result.heartbeatSkipped).toBe(1);
      expect(result.failedInProgress).toBe(0);
    });

    it('fails in_progress tasks when node heartbeat is stale', async () => {
      const now = Date.now();
      const startedAt = new Date(now - 5 * 60 * 60 * 1000).toISOString();
      const updatedAt = new Date(now - 5 * 60 * 60 * 1000).toISOString();
      // Heartbeat 10 minutes ago (stale, > 180 seconds)
      const staleHeartbeat = new Date(now - 10 * 60 * 1000).toISOString();

      const responses = new Map<string, { results: unknown[]; changes?: number }>();
      responses.set('status IN (\'queued\', \'delegated\', \'in_progress\')', {
        results: [
          {
            id: 'task-1',
            project_id: 'proj-1',
            user_id: 'user-1',
            status: 'in_progress',
            execution_step: 'running',
            updated_at: updatedAt,
            started_at: startedAt,
            workspace_id: 'ws-1',
            auto_provisioned_node_id: 'node-1',
          },
        ],
      });
      responses.set('node_id FROM workspaces', {
        results: [{ node_id: 'node-1' }],
      });
      responses.set('last_heartbeat_at FROM nodes', {
        results: [{ last_heartbeat_at: staleHeartbeat }],
      });
      // Workspace status for diagnostics
      responses.set('node_id, status FROM workspaces', {
        results: [{ id: 'ws-1', node_id: 'node-1', status: 'running' }],
      });
      // Node status for diagnostics
      responses.set('status, health_status FROM nodes', {
        results: [{ id: 'node-1', status: 'running', health_status: 'healthy' }],
      });
      // Task update (mark as failed)
      responses.set('UPDATE tasks SET status = \'failed\'', {
        results: [],
        changes: 1,
      });

      const env = createMockEnv(responses);
      const result = await recoverStuckTasks(env);

      expect(result.failedInProgress).toBe(1);
      expect(result.heartbeatSkipped).toBe(0);
    });

    it('fails in_progress tasks with no node (no heartbeat to check)', async () => {
      const now = Date.now();
      const startedAt = new Date(now - 5 * 60 * 60 * 1000).toISOString();
      const updatedAt = new Date(now - 5 * 60 * 60 * 1000).toISOString();

      const responses = new Map<string, { results: unknown[]; changes?: number }>();
      responses.set('status IN (\'queued\', \'delegated\', \'in_progress\')', {
        results: [
          {
            id: 'task-1',
            project_id: 'proj-1',
            user_id: 'user-1',
            status: 'in_progress',
            execution_step: 'running',
            updated_at: updatedAt,
            started_at: startedAt,
            workspace_id: null,
            auto_provisioned_node_id: null,
          },
        ],
      });
      // Workspace status for diagnostics
      responses.set('node_id, status FROM workspaces', {
        results: [],
      });
      // Task update
      responses.set('UPDATE tasks SET status = \'failed\'', {
        results: [],
        changes: 1,
      });

      const env = createMockEnv(responses);
      const result = await recoverStuckTasks(env);

      expect(result.failedInProgress).toBe(1);
      expect(result.heartbeatSkipped).toBe(0);
    });
  });

  describe('result structure', () => {
    it('returns all expected counters including heartbeatSkipped', async () => {
      const env = createMockEnv(new Map([
        ['status IN (\'queued\', \'delegated\', \'in_progress\')', { results: [] }],
      ]));
      const result = await recoverStuckTasks(env);

      expect(result).toEqual({
        failedQueued: 0,
        failedDelegated: 0,
        failedInProgress: 0,
        heartbeatSkipped: 0,
        doHealthChecked: 0,
        errors: 0,
      });
    });
  });
});
