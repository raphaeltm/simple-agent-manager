/**
 * Unit tests for stuck task recovery — heartbeat-aware lifecycle.
 *
 * Verifies:
 * 1. In-progress tasks with recent heartbeats are NOT marked as stuck
 * 2. In-progress tasks with stale heartbeats ARE marked as stuck
 * 3. Tasks without a node are treated as stuck (no heartbeat to check)
 */
import { beforeEach,describe, expect, it, vi } from 'vitest';

import type { Env } from '../../src/env';
import { detectClaudeCodeCompactionLoop } from '../../src/scheduled/claude-code-compaction-loop';
import { recoverStuckTasks } from '../../src/scheduled/stuck-tasks';
import { persistError } from '../../src/services/observability';
import { cleanupTaskRun } from '../../src/services/task-runner';

// Mock cleanupTaskRun
vi.mock('../../src/services/task-runner', () => ({
  cleanupTaskRun: vi.fn().mockResolvedValue(undefined),
}));

// Mock persistError
vi.mock('../../src/services/observability', () => ({
  persistError: vi.fn().mockResolvedValue(undefined),
}));

const { projectDataMocks } = vi.hoisted(() => ({
  projectDataMocks: {
    getMessages: vi.fn(),
    listSessions: vi.fn(),
    listAcpSessions: vi.fn(),
    failSession: vi.fn(),
  },
}));
vi.mock('../../src/services/project-data', () => projectDataMocks);

// Mock trigger execution sync
const { syncTriggerExecutionMock } = vi.hoisted(() => ({
  syncTriggerExecutionMock: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../src/services/trigger-execution-sync', () => ({
  syncTriggerExecutionStatus: syncTriggerExecutionMock,
}));

// Mock logger
vi.mock('../../src/lib/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  createModuleLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
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

function createMockEnv(
  prepareResponses: Map<string, { results: unknown[]; changes?: number }> = new Map(),
  envOverrides: Partial<Record<string, string>> = {},
): Env {
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
    TASK_RUN_HARD_TIMEOUT_MS: '28800000', // 8 hours
    TASK_STUCK_QUEUED_TIMEOUT_MS: '600000', // 10 min
    TASK_STUCK_DELEGATED_TIMEOUT_MS: '1860000', // 31 min
    NODE_HEARTBEAT_STALE_SECONDS: '180', // 3 min
    TASK_RUNNER: mockTaskRunnerDO,
    ...envOverrides,
  } as unknown as Env;
}

describe('recoverStuckTasks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    projectDataMocks.getMessages.mockResolvedValue({ messages: [], hasMore: false });
    projectDataMocks.listSessions.mockResolvedValue({ sessions: [], total: 0 });
    projectDataMocks.listAcpSessions.mockResolvedValue({
      sessions: [{
        id: 'acp-live',
        status: 'running',
        workspaceId: 'ws-1',
        lastHeartbeatAt: Date.now(),
      }],
      total: 1,
    });
    projectDataMocks.failSession.mockResolvedValue(undefined);
  });

  describe('detectClaudeCodeCompactionLoop', () => {
    it('detects repeated compaction marker pairs in the recent window', () => {
      const evidence = detectClaudeCodeCompactionLoop(
        [
          { role: 'assistant', content: 'Working normally' },
          { role: 'system', content: 'Compacting...' },
          { role: 'system', content: 'Compacting completed' },
          { role: 'system', content: 'Compacting...' },
          { role: 'system', content: 'Compacting completed' },
          { role: 'system', content: 'Compacting...' },
          { role: 'system', content: 'Compacting completed' },
        ],
        { windowMessages: 6, minPairs: 3 },
      );

      expect(evidence.detected).toBe(true);
      expect(evidence.markerPairs).toBe(3);
      expect(evidence.snippets.length).toBeGreaterThan(0);
    });

    it('does not detect partial or sparse marker evidence', () => {
      const evidence = detectClaudeCodeCompactionLoop(
        [
          { role: 'system', content: 'Compacting...' },
          { role: 'assistant', content: 'I made progress after compaction.' },
          { role: 'system', content: 'Compacting completed' },
        ],
        { windowMessages: 3, minPairs: 2 },
      );

      expect(evidence.detected).toBe(false);
      expect(evidence.markerPairs).toBe(1);
    });
  });

  describe('Claude Code compaction-loop recovery', () => {
    it('fails an active Claude Code task when recent session messages show repeated compaction markers', async () => {
      const now = Date.now();
      const recent = new Date(now - 30 * 1000).toISOString();
      const responses = new Map<string, { results: unknown[]; changes?: number }>();
      responses.set('status IN (\'queued\', \'delegated\', \'in_progress\')', {
        results: [
          {
            id: 'task-compaction-loop',
            project_id: 'proj-1',
            user_id: 'user-1',
            status: 'in_progress',
            execution_step: 'running',
            updated_at: recent,
            started_at: recent,
            workspace_id: 'ws-1',
            auto_provisioned_node_id: 'node-1',
          },
        ],
      });
      responses.set('FROM agent_sessions', {
        results: [{ id: 'agent-session-1', agent_type: 'claude-code' }],
      });
      responses.set('chat_session_id FROM workspaces', {
        results: [{ chat_session_id: 'chat-session-1' }],
      });
      responses.set('node_id, status FROM workspaces', {
        results: [{ id: 'ws-1', node_id: 'node-1', status: 'running' }],
      });
      responses.set('status, health_status FROM nodes', {
        results: [{ id: 'node-1', status: 'running', health_status: 'healthy' }],
      });
      responses.set('UPDATE tasks SET status = \'failed\'', {
        results: [],
        changes: 1,
      });
      projectDataMocks.getMessages.mockResolvedValue({
        messages: [
          { role: 'system', content: 'Compacting...', createdAt: 1 },
          { role: 'system', content: 'Compacting completed', createdAt: 2 },
          { role: 'system', content: 'Compacting...', createdAt: 3 },
          { role: 'system', content: 'Compacting completed', createdAt: 4 },
          { role: 'system', content: 'Compacting...', createdAt: 5 },
          { role: 'system', content: 'Compacting completed', createdAt: 6 },
        ],
        hasMore: false,
      });

      const env = createMockEnv(responses, {
        CLAUDE_CODE_COMPACTION_LOOP_MIN_PAIRS: '3',
        CLAUDE_CODE_COMPACTION_LOOP_WINDOW_MESSAGES: '10',
      });

      const result = await recoverStuckTasks(env);

      expect(result.failedCompactionLoops).toBe(1);
      expect(result.failedInProgress).toBe(1);
      expect(projectDataMocks.getMessages).toHaveBeenCalledWith(
        env,
        'proj-1',
        'chat-session-1',
        40,
        null,
        ['assistant', 'system', 'tool'],
        false,
        'desc',
      );
      expect(projectDataMocks.failSession).toHaveBeenCalledWith(
        env,
        'proj-1',
        'chat-session-1',
        expect.stringContaining('Claude Code compaction loop detected'),
      );
      expect(syncTriggerExecutionMock).toHaveBeenCalledWith(
        env.DATABASE,
        'task-compaction-loop',
        'failed',
        expect.stringContaining('Claude Code compaction loop detected'),
      );
      expect(cleanupTaskRun).toHaveBeenCalledWith('task-compaction-loop', env);
      expect(persistError).toHaveBeenCalledWith(
        env.OBSERVABILITY_DATABASE,
        expect.objectContaining({
          source: 'api',
          level: 'warn',
          message: expect.stringContaining('Claude Code compaction loop detected'),
          context: expect.objectContaining({
            recoveryType: 'claude_code_compaction_loop',
            compactionLoop: expect.objectContaining({
              sessionId: 'chat-session-1',
              agentSessionId: 'agent-session-1',
              recentMessageLimit: 40,
              evidence: expect.objectContaining({
                detected: true,
                markerPairs: 3,
                snippets: expect.arrayContaining([expect.stringContaining('Compacting')]),
              }),
            }),
          }),
        }),
      );
    });

    it('does not fail a fresh in-progress task without a running Claude Code agent session', async () => {
      const recent = new Date(Date.now() - 30 * 1000).toISOString();
      const responses = new Map<string, { results: unknown[]; changes?: number }>();
      responses.set('status IN (\'queued\', \'delegated\', \'in_progress\')', {
        results: [
          {
            id: 'task-opencode',
            project_id: 'proj-1',
            user_id: 'user-1',
            status: 'in_progress',
            execution_step: 'running',
            updated_at: recent,
            started_at: recent,
            workspace_id: 'ws-1',
            auto_provisioned_node_id: null,
          },
        ],
      });
      responses.set('FROM agent_sessions', {
        results: [],
      });

      const env = createMockEnv(responses);
      const result = await recoverStuckTasks(env);

      expect(result.failedCompactionLoops).toBe(0);
      expect(result.failedInProgress).toBe(0);
      expect(projectDataMocks.getMessages).not.toHaveBeenCalled();
      expect(projectDataMocks.failSession).not.toHaveBeenCalled();
    });
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
      responses.set('w.chat_session_id', {
        results: [{ workspace_status: 'running', chat_session_id: 'chat-1', node_id: 'node-1', node_status: 'running', health_status: 'healthy', last_heartbeat_at: recentHeartbeat }],
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
      responses.set('w.chat_session_id', {
        results: [{ workspace_status: 'running', chat_session_id: 'chat-1', node_id: 'node-1', node_status: 'running', health_status: 'healthy', last_heartbeat_at: staleHeartbeat }],
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

      // Verify trigger execution sync was called for the failed task
      expect(syncTriggerExecutionMock).toHaveBeenCalledWith(
        env.DATABASE,
        'task-1',
        'failed',
        expect.stringContaining('runtime is no longer live'),
      );
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

  describe('hard timeout enforcement', () => {
    it('preserves a genuinely live task past the hard timeout', async () => {
      const now = Date.now();
      // Task started 9 hours ago (past 8h hard timeout)
      const startedAt = new Date(now - 9 * 60 * 60 * 1000).toISOString();
      const updatedAt = new Date(now - 9 * 60 * 60 * 1000).toISOString();
      // Heartbeat 30 seconds ago (recent — would normally cause a skip)
      const recentHeartbeat = new Date(now - 30 * 1000).toISOString();

      const responses = new Map<string, { results: unknown[]; changes?: number }>();
      responses.set('status IN (\'queued\', \'delegated\', \'in_progress\')', {
        results: [
          {
            id: 'task-hard',
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
      // Workspace lookup — should NOT be called because hard timeout short-circuits
      responses.set('node_id FROM workspaces', {
        results: [{ node_id: 'node-1' }],
      });
      // Heartbeat check — should NOT be reached
      responses.set('last_heartbeat_at FROM nodes', {
        results: [{ last_heartbeat_at: recentHeartbeat }],
      });
      responses.set('w.chat_session_id', {
        results: [{ workspace_status: 'running', chat_session_id: 'chat-1', node_id: 'node-1', node_status: 'running', health_status: 'healthy', last_heartbeat_at: recentHeartbeat }],
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

      expect(result.failedInProgress).toBe(0);
      expect(result.heartbeatSkipped).toBe(1);
      expect(projectDataMocks.listAcpSessions).toHaveBeenCalled();
    });

    it('preserves heartbeat grace between soft and hard timeout', async () => {
      const now = Date.now();
      // Task started 5 hours ago (past 4h soft, before 8h hard)
      const startedAt = new Date(now - 5 * 60 * 60 * 1000).toISOString();
      const updatedAt = new Date(now - 5 * 60 * 60 * 1000).toISOString();
      // Heartbeat 30 seconds ago (recent)
      const recentHeartbeat = new Date(now - 30 * 1000).toISOString();

      const responses = new Map<string, { results: unknown[]; changes?: number }>();
      responses.set('status IN (\'queued\', \'delegated\', \'in_progress\')', {
        results: [
          {
            id: 'task-grace',
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
        results: [{ last_heartbeat_at: recentHeartbeat }],
      });
      responses.set('w.chat_session_id', {
        results: [{ workspace_status: 'running', chat_session_id: 'chat-1', node_id: 'node-1', node_status: 'running', health_status: 'healthy', last_heartbeat_at: recentHeartbeat }],
      });

      const env = createMockEnv(responses);
      const result = await recoverStuckTasks(env);

      // In the 4h-8h window with fresh heartbeat, task should be skipped (grace period)
      expect(result.heartbeatSkipped).toBe(1);
      expect(result.failedInProgress).toBe(0);
    });

    it('terminates tasks in soft-hard window with stale heartbeat', async () => {
      const now = Date.now();
      // Task started 5 hours ago (past 4h soft, before 8h hard)
      const startedAt = new Date(now - 5 * 60 * 60 * 1000).toISOString();
      const updatedAt = new Date(now - 5 * 60 * 60 * 1000).toISOString();
      // Heartbeat 10 minutes ago (stale, > 180 seconds)
      const staleHeartbeat = new Date(now - 10 * 60 * 1000).toISOString();

      const responses = new Map<string, { results: unknown[]; changes?: number }>();
      responses.set('status IN (\'queued\', \'delegated\', \'in_progress\')', {
        results: [
          {
            id: 'task-stale-grace',
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
      responses.set('node_id, status FROM workspaces', {
        results: [{ id: 'ws-1', node_id: 'node-1', status: 'running' }],
      });
      responses.set('status, health_status FROM nodes', {
        results: [{ id: 'node-1', status: 'running', health_status: 'healthy' }],
      });
      responses.set('UPDATE tasks SET status = \'failed\'', {
        results: [],
        changes: 1,
      });

      const env = createMockEnv(responses);
      const result = await recoverStuckTasks(env);

      // Stale heartbeat in the 4h-8h window — task should be terminated
      expect(result.failedInProgress).toBe(1);
      expect(result.heartbeatSkipped).toBe(0);
    });

    it('respects custom hard timeout from env var', async () => {
      const now = Date.now();
      // Custom hard timeout: 2 hours (7200000ms)
      // Task started 3 hours ago — past custom hard timeout
      const startedAt = new Date(now - 3 * 60 * 60 * 1000).toISOString();
      const updatedAt = new Date(now - 3 * 60 * 60 * 1000).toISOString();
      // Fresh heartbeat — would normally grant grace
      const recentHeartbeat = new Date(now - 30 * 1000).toISOString();

      const responses = new Map<string, { results: unknown[]; changes?: number }>();
      responses.set('status IN (\'queued\', \'delegated\', \'in_progress\')', {
        results: [
          {
            id: 'task-custom',
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
        results: [{ last_heartbeat_at: recentHeartbeat }],
      });
      responses.set('node_id, status FROM workspaces', {
        results: [{ id: 'ws-1', node_id: 'node-1', status: 'running' }],
      });
      responses.set('status, health_status FROM nodes', {
        results: [{ id: 'node-1', status: 'running', health_status: 'healthy' }],
      });
      responses.set('UPDATE tasks SET status = \'failed\'', {
        results: [],
        changes: 1,
      });

      // Override hard timeout to 2 hours and soft timeout to 1 hour
      const env = createMockEnv(responses, {
        TASK_RUN_HARD_TIMEOUT_MS: '7200000',
        TASK_RUN_MAX_EXECUTION_MS: '3600000',
      });
      const result = await recoverStuckTasks(env);

      // 3h task > 2h custom hard timeout — killed despite fresh heartbeat
      expect(result.failedInProgress).toBe(1);
      expect(result.heartbeatSkipped).toBe(0);
    });
  });

  describe('queued and delegated stuck task recovery', () => {
    it('fails queued tasks past the queued timeout', async () => {
      const now = Date.now();
      // Task stuck in queued for 11 minutes (> 10 min threshold)
      const updatedAt = new Date(now - 11 * 60 * 1000).toISOString();

      const responses = new Map<string, { results: unknown[]; changes?: number }>();
      responses.set('status IN (\'queued\', \'delegated\', \'in_progress\')', {
        results: [
          {
            id: 'task-q',
            project_id: 'proj-1',
            user_id: 'user-1',
            status: 'queued',
            execution_step: 'node_provisioning',
            updated_at: updatedAt,
            started_at: null,
            workspace_id: null,
            auto_provisioned_node_id: null,
          },
        ],
      });
      responses.set('UPDATE tasks SET status = \'failed\'', { results: [], changes: 1 });

      const env = createMockEnv(responses);
      const result = await recoverStuckTasks(env);

      expect(result.failedQueued).toBe(1);
    });

    it('fails delegated tasks past the delegated timeout', async () => {
      const now = Date.now();
      // Task stuck in delegated for 32 minutes (> 31 min threshold)
      const updatedAt = new Date(now - 32 * 60 * 1000).toISOString();

      const responses = new Map<string, { results: unknown[]; changes?: number }>();
      responses.set('status IN (\'queued\', \'delegated\', \'in_progress\')', {
        results: [
          {
            id: 'task-d',
            project_id: 'proj-1',
            user_id: 'user-1',
            status: 'delegated',
            execution_step: 'workspace_creation',
            updated_at: updatedAt,
            started_at: null,
            workspace_id: 'ws-1',
            auto_provisioned_node_id: 'node-1',
          },
        ],
      });
      responses.set('UPDATE tasks SET status = \'failed\'', { results: [], changes: 1 });

      const env = createMockEnv(responses);
      const result = await recoverStuckTasks(env);

      expect(result.failedDelegated).toBe(1);
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
        failedCompactionLoops: 0,
        heartbeatSkipped: 0,
        doHealthChecked: 0,
        errors: 0,
      });
    });
  });
});
