/**
 * Unit tests for the task-mode inactivity reconciliation module.
 *
 * Uses better-sqlite3 as a stand-in for DO SQLite. D1 queries and
 * VM agent calls are mocked since they cross service boundaries.
 */
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runMigrations } from '../../../src/durable-objects/migrations';
import { computeProjectDataAlarmTime } from '../../../src/durable-objects/project-data/alarm-schedule';
import {
  createAttentionMarker,
  getExpiredMarkers,
  resolveAttentionMarkerById,
  resolveAttentionMarkers,
} from '../../../src/durable-objects/project-data/attention';
import {
  computeReconciliationAlarmTime,
  getReconciliationCandidates,
  processReconciliationCandidates,
} from '../../../src/durable-objects/project-data/reconciliation';
import { createSqlStorage } from './sql-storage-test-utils';

// Mock the node-agent service to prevent real HTTP calls while preserving the
// versioned receipt contract reconciliation now depends on.
const nodeAgentMocks = vi.hoisted(() => ({
  runtimeIdentity: 'runtime-1',
  NodeAgentHttpError: class NodeAgentHttpError extends Error {
    constructor(
      public readonly statusCode: number,
      public readonly responseBody: string
    ) {
      super(`Node Agent request failed: ${statusCode} ${responseBody}`);
    }
  },
  nodeAgentRequest: vi.fn(async (_nodeId: unknown, _env: unknown, path: string) => {
    if (path.endsWith('/agent-capabilities')) {
      return {
        protocolVersion: 1,
        runtimeIdentity: 'runtime-1',
        promptReceipts: {
          supported: true,
          lookup: true,
          states: ['accepted', 'in_flight', 'completed', 'not_found', 'ambiguous'],
        },
        checkpointRollover: {
          supported: false,
          automatic: false,
          states: [],
          defaultGraceMs: 0,
          maxGraceMs: 0,
          operationTimeoutMs: 0,
        },
      };
    }
    const deliveryId = path.split('/').at(-1) ?? '';
    return {
      deliveryId,
      state: 'not_found',
      runtimeIdentity: 'runtime-1',
      acceptedAt: null,
      completedAt: null,
    };
  }),
  sendPromptToAgentOnNode: vi.fn(
    async (
      _nodeId: unknown,
      _workspaceId: unknown,
      acpSessionId: string,
      _prompt: unknown,
      _env: unknown,
      _userId: unknown,
      _messageId: unknown,
      options: { deliveryId?: string } | undefined
    ) => ({
      status: 'accepted',
      sessionId: acpSessionId,
      receipt: {
        deliveryId: options?.deliveryId ?? '',
        state: 'accepted',
        runtimeIdentity: 'runtime-1',
        acceptedAt: Date.now(),
        completedAt: null,
      },
    })
  ),
  cancelAgentSessionOnNode: vi.fn().mockResolvedValue({ success: true, status: 200 }),
}));
vi.mock('../../../src/services/node-agent', () => ({
  NodeAgentHttpError: nodeAgentMocks.NodeAgentHttpError,
  nodeAgentRequest: nodeAgentMocks.nodeAgentRequest,
  sendPromptToAgentOnNode: nodeAgentMocks.sendPromptToAgentOnNode,
  cancelAgentSessionOnNode: nodeAgentMocks.cancelAgentSessionOnNode,
}));
vi.mock('../../../src/services/project-data', () => ({ reconcileTaskWaits: vi.fn() }));
vi.mock('../../../src/services/vm-admission-control', () => ({
  cancelVmTaskAdmission: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../src/services/task-runner', () => ({
  cleanupTaskRun: vi.fn().mockResolvedValue(undefined),
}));

/** Helper to create a D1Database mock with configurable task queries */
interface MockTaskRow {
  id?: string;
  task_mode: string;
  status: string;
  project_id?: string;
  workspace_id?: string | null;
  chat_session_id?: string | null;
  parent_task_id?: string | null;
  recovery_source_task_id?: string | null;
  trigger_execution_id?: string | null;
  triggered_by?: string;
  created_at?: string;
  error_message?: string | null;
  started_at?: string | null;
  completed_at?: string | null;
  execution_step?: string | null;
}

interface MockWorkspaceRow {
  node_id: string | null;
  user_id: string;
  project_id?: string | null;
  status?: string;
  chat_session_id?: string | null;
  node_runtime?: string | null;
  node_status?: string | null;
  health_status?: string | null;
  last_heartbeat_at?: string | null;
}

function createMockD1(
  taskRows: Record<string, MockTaskRow> = {},
  workspaceRows: Record<string, MockWorkspaceRow> = {}
) {
  const runCalls: Array<{ query: string; args: unknown[] }> = [];
  const statusEvents: Array<Record<string, unknown>> = [];
  function workspaceIdForTask(taskId: string): string | null {
    if (taskRows[taskId]?.workspace_id !== undefined) return taskRows[taskId].workspace_id ?? null;
    if (taskId === 'task-1') return 'ws-1';
    const numberedTask = /^task-(.+)$/.exec(taskId);
    if (numberedTask?.[1]) return `ws-${numberedTask[1]}`;
    return taskId.replace(/-task$/, '-ws');
  }
  function chatSessionIdForTask(taskId: string): string | null {
    if (taskRows[taskId]?.chat_session_id !== undefined) {
      return taskRows[taskId].chat_session_id ?? null;
    }
    if (taskId === 'task-1') return 'session-1';
    const numberedTask = /^task-(.+)$/.exec(taskId);
    if (numberedTask?.[1]) return `session-${numberedTask[1]}`;
    return taskId.replace(/-task$/, '-session');
  }
  function chatSessionIdForWorkspace(workspaceId: string): string | null {
    const taskId = Object.keys(taskRows).find(
      (candidateTaskId) => workspaceIdForTask(candidateTaskId) === workspaceId
    );
    return taskId ? chatSessionIdForTask(taskId) : null;
  }
  function richTaskRow(taskId: string): MockTaskRow | null {
    const row = taskRows[taskId];
    if (!row) return null;
    return {
      id: taskId,
      project_id: 'project-1',
      workspace_id: workspaceIdForTask(taskId),
      chat_session_id: chatSessionIdForTask(taskId),
      parent_task_id: null,
      recovery_source_task_id: null,
      trigger_execution_id: null,
      triggered_by: 'user',
      created_at: new Date(Date.now() - 60_000).toISOString(),
      error_message: null,
      started_at: null,
      completed_at: null,
      execution_step: 'awaiting_followup',
      ...row,
    };
  }
  async function runStatement(query: string, args: unknown[]) {
    runCalls.push({ query, args });
    if (query.includes('UPDATE tasks') && query.includes('execution_step = NULL')) {
      const taskId = args[6] as string;
      const projectId = args[7] as string;
      const fromStatus = args[8] as string;
      const workspaceId = args[9] as string | null;
      const chatSessionId = args[11] as string | null;
      const row = richTaskRow(taskId);
      if (
        row &&
        row.project_id === projectId &&
        row.status === fromStatus &&
        (workspaceId === null || row.workspace_id === workspaceId) &&
        (chatSessionId === null || row.chat_session_id === chatSessionId)
      ) {
        taskRows[taskId] = {
          ...row,
          status: args[0] as string,
          error_message: args[1] as string | null,
          started_at: (row.started_at ?? args[3]) as string | null,
          completed_at: args[4] as string,
          execution_step: null,
        };
        return { success: true, meta: { changes: 1 } };
      }
      return { success: true, meta: { changes: 0 } };
    }
    if (query.includes('INSERT INTO task_status_events')) {
      const taskId = args[7] as string;
      const row = richTaskRow(taskId);
      if (row?.status === args[9] && row.completed_at === args[10]) {
        statusEvents.push({
          task_id: taskId,
          from_status: args[1],
          to_status: args[2],
          actor_type: args[3],
          actor_id: args[4],
          reason: args[5],
        });
        return { success: true, meta: { changes: 1 } };
      }
      return { success: true, meta: { changes: 0 } };
    }
    if (query.includes('UPDATE workspaces')) {
      const workspaceId = args[1] as string;
      const row = workspaceRows[workspaceId];
      if (row) row.status = 'stopped';
      return { success: true, meta: { changes: row ? 1 : 0 } };
    }
    return { success: true, meta: { changes: 0 } };
  }
  return {
    __runCalls: runCalls,
    __statusEvents: statusEvents,
    prepare: vi.fn().mockImplementation((query: string) => ({
      bind: vi.fn().mockImplementation((...args: unknown[]) => ({
        first: vi.fn().mockImplementation(async () => {
          if (query.includes('WITH RECURSIVE supersession_chain')) {
            return null;
          }
          if (query.includes('FROM tasks')) {
            return richTaskRow(args[0] as string);
          }
          if (query.includes('FROM workspaces')) {
            const row = workspaceRows[args[0] as string];
            if (!row) return null;
            const fullRow = { project_id: 'project-1', ...row };
            return {
              id: args[0] as string,
              workspace_status: fullRow.status ?? 'running',
              chat_session_id:
                fullRow.chat_session_id ?? chatSessionIdForWorkspace(args[0] as string),
              node_id: fullRow.node_id,
              user_id: fullRow.user_id,
              node_runtime: fullRow.node_runtime ?? 'vm',
              project_id: 'project-1',
              node_status: 'running',
              health_status: 'healthy',
              last_heartbeat_at: new Date(Date.now()).toISOString(),
              running_workspaces_on_node: fullRow.node_id ? 1 : 0,
              ...fullRow,
            };
          }
          if (query.includes('FROM acp_sessions')) {
            return { id: `acp-${args[0]}` };
          }
          return null;
        }),
        run: vi.fn().mockImplementation(() => runStatement(query, args)),
      })),
    })),
    batch: vi
      .fn()
      .mockImplementation(async (statements: Array<{ run: () => Promise<unknown> }>) =>
        Promise.all(statements.map((statement) => statement.run()))
      ),
  } as unknown as D1Database;
}

const FIVE_MINUTES = 5 * 60 * 1000;
const ONE_MINUTE = 60 * 1000;
const THIRTY_MINUTES = 30 * 60 * 1000;
const TWO_HOURS = 2 * 60 * 60 * 1000;
type ProjectDataEnv = import('../../../src/durable-objects/project-data/types').Env;

describe('Task Reconciliation Module', () => {
  let db: Database.Database;
  let sql: SqlStorage;
  const now = Date.now();

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(now);

    db = new Database(':memory:');
    sql = createSqlStorage(db);
    runMigrations(sql);
    vi.clearAllMocks();
  });

  afterEach(() => {
    db.close();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /** Helper to set up a task-mode session with idle cleanup and workspace activity */
  function setupTaskSession(
    opts: {
      sessionId?: string;
      workspaceId?: string;
      taskId?: string;
      lastActivityAt?: number;
      acpSessionId?: string;
      withIdleCleanup?: boolean;
    } = {}
  ) {
    const sessionId = opts.sessionId ?? 'session-1';
    const workspaceId = opts.workspaceId ?? 'ws-1';
    const taskId = opts.taskId ?? 'task-1';
    const lastActivityAt = opts.lastActivityAt ?? now - FIVE_MINUTES - 1000;
    const acpSessionId = opts.acpSessionId ?? 'acp-1';
    const withIdleCleanup = opts.withIdleCleanup ?? true;

    // Create chat session
    db.prepare(
      `INSERT INTO chat_sessions (id, workspace_id, task_id, topic, status, message_count, started_at, created_at, updated_at)
       VALUES (?, ?, ?, 'Test', 'active', 0, ?, ?, ?)`
    ).run(sessionId, workspaceId, taskId, now - 600000, now - 600000, now - 600000);

    if (withIdleCleanup) {
      db.prepare(
        `INSERT INTO idle_cleanup_schedule (session_id, workspace_id, task_id, cleanup_at, created_at, retry_count)
         VALUES (?, ?, ?, ?, ?, 0)`
      ).run(sessionId, workspaceId, taskId, now + 900000, now - 600000);
    }

    // Create workspace activity
    db.prepare(
      `INSERT INTO workspace_activity (workspace_id, session_id, last_message_at, last_terminal_activity_at, created_at)
       VALUES (?, ?, ?, 0, ?)`
    ).run(workspaceId, sessionId, lastActivityAt, lastActivityAt);

    // Create ACP session
    db.prepare(
      `INSERT INTO acp_sessions (id, chat_session_id, status, agent_type, created_at, updated_at)
       VALUES (?, ?, 'running', 'claude_code', ?, ?)`
    ).run(acpSessionId, sessionId, now - 600000, now - 600000);

    // Link ACP session to workspace
    db.prepare(`UPDATE acp_sessions SET workspace_id = ? WHERE id = ?`).run(
      workspaceId,
      acpSessionId
    );
  }

  function envWithRows(
    taskRows: Record<string, MockTaskRow> = {},
    workspaceRows: Record<string, MockWorkspaceRow> = {}
  ): ProjectDataEnv {
    return { DATABASE: createMockD1(taskRows, workspaceRows) } as unknown as ProjectDataEnv;
  }

  async function candidatesForTask(taskMode: string, status: string) {
    setupTaskSession();
    return getReconciliationCandidates(
      sql,
      envWithRows({
        'task-1': { task_mode: taskMode, status },
      })
    );
  }

  function setAcpHeartbeat(acpSessionId = 'acp-1', heartbeatAt = now) {
    db.prepare(
      `UPDATE acp_sessions SET node_id = 'node-1', last_heartbeat_at = ? WHERE id = ?`
    ).run(heartbeatAt, acpSessionId);
  }

  function setSessionActivity(
    opts: {
      acpSessionId?: string;
      activity?: string;
      activityAt?: number;
      promptStartedAt?: number | null;
    } = {}
  ) {
    const acpSessionId = opts.acpSessionId ?? 'acp-1';
    const activity = opts.activity ?? 'prompting';
    const activityAt = opts.activityAt ?? now;
    const promptStartedAt = opts.promptStartedAt ?? activityAt;
    db.prepare(
      `INSERT INTO session_state (session_id, activity, activity_at, prompt_started_at, restart_count)
       VALUES (?, ?, ?, ?, 0)
       ON CONFLICT(session_id) DO UPDATE SET
         activity = excluded.activity,
         activity_at = excluded.activity_at,
         prompt_started_at = excluded.prompt_started_at`
    ).run(acpSessionId, activity, activityAt, promptStartedAt);
  }

  describe('getReconciliationCandidates', () => {
    it('selects task-mode sessions idle for 5 minutes', async () => {
      const candidates = await candidatesForTask('task', 'in_progress');

      expect(candidates).toHaveLength(1);
      expect(candidates[0].sessionId).toBe('session-1');
      expect(candidates[0].taskId).toBe('task-1');
      expect(candidates[0].workspaceId).toBe('ws-1');
      expect(candidates[0].acpSessionId).toBe('acp-1');
      expect(candidates[0].idleDurationMs).toBeGreaterThan(FIVE_MINUTES);
    });

    it('selects task-mode sessions even when idle cleanup schedule is missing', async () => {
      setupTaskSession({ withIdleCleanup: false });

      const candidates = await getReconciliationCandidates(
        sql,
        envWithRows({
          'task-1': { task_mode: 'task', status: 'in_progress' },
        })
      );

      expect(candidates).toHaveLength(1);
      expect(candidates[0]).toMatchObject({
        sessionId: 'session-1',
        taskId: 'task-1',
        workspaceId: 'ws-1',
        acpSessionId: 'acp-1',
      });
    });

    it('binds the ACP owner to the exact chat when a workspace has a newer unrelated session', async () => {
      setupTaskSession({ acpSessionId: 'acp-current' });
      db.prepare(
        `INSERT INTO chat_sessions
           (id, workspace_id, task_id, topic, status, message_count, started_at, created_at, updated_at)
         VALUES ('session-unrelated', 'ws-1', 'task-unrelated', 'Other', 'active', 0, ?, ?, ?)`
      ).run(now, now, now);
      db.prepare(
        `INSERT INTO acp_sessions
           (id, chat_session_id, workspace_id, status, agent_type, created_at, updated_at)
         VALUES ('acp-newer-unrelated', 'session-unrelated', 'ws-1', 'running', 'codex', ?, ?)`
      ).run(now + 1000, now + 1000);

      const candidates = await getReconciliationCandidates(
        sql,
        envWithRows({
          'task-1': { task_mode: 'task', status: 'in_progress' },
          'task-unrelated': { task_mode: 'task', status: 'in_progress' },
        })
      );

      expect(candidates).toHaveLength(1);
      expect(candidates[0]).toMatchObject({
        sessionId: 'session-1',
        acpSessionId: 'acp-current',
      });
    });

    it('advances a durable cursor past permanently ineligible oldest rows', async () => {
      for (let index = 1; index <= 3; index++) {
        setupTaskSession({
          sessionId: `session-${index}`,
          workspaceId: `ws-${index}`,
          taskId: `task-${index}`,
          acpSessionId: `acp-${index}`,
          lastActivityAt: now - FIVE_MINUTES - 1000,
        });
      }
      const mockDb = createMockD1({
        'task-1': { task_mode: 'task', status: 'completed' },
        'task-2': { task_mode: 'conversation', status: 'in_progress' },
        'task-3': { task_mode: 'task', status: 'in_progress' },
      });
      const env = {
        DATABASE: mockDb,
        TASK_RECONCILIATION_MAX_CANDIDATES_PER_SWEEP: '2',
      } as unknown as ProjectDataEnv;

      expect(await getReconciliationCandidates(sql, env)).toEqual([]);
      const firstSweepTaskReads = vi
        .mocked(mockDb.prepare)
        .mock.calls.filter(([query]) => String(query).includes('FROM tasks')).length;
      expect(firstSweepTaskReads).toBe(2);

      const secondSweep = await getReconciliationCandidates(sql, env);
      const totalTaskReads = vi
        .mocked(mockDb.prepare)
        .mock.calls.filter(([query]) => String(query).includes('FROM tasks')).length;
      expect(totalTaskReads - firstSweepTaskReads).toBeLessThanOrEqual(2);
      expect(secondSweep).toEqual([
        expect.objectContaining({ sessionId: 'session-3', taskId: 'task-3' }),
      ]);

      createAttentionMarker(sql, {
        sessionId: 'session-3',
        taskId: 'task-3',
        workspaceId: 'ws-3',
        kind: 'needs_input',
        source: 'agent',
      });
      const taskReadsBeforeWrap = vi
        .mocked(mockDb.prepare)
        .mock.calls.filter(([query]) => String(query).includes('FROM tasks')).length;

      // Wrap the cursor twice. Stable task-scoped exclusions must be applied
      // before LIMIT so the oldest permanent rows cannot consume D1 budget or
      // keep the ProjectData alarm hot forever.
      expect(await getReconciliationCandidates(sql, env)).toEqual([]);
      expect(await getReconciliationCandidates(sql, env)).toEqual([]);
      const taskReadsAfterWrap = vi
        .mocked(mockDb.prepare)
        .mock.calls.filter(([query]) => String(query).includes('FROM tasks')).length;
      expect(taskReadsAfterWrap).toBe(taskReadsBeforeWrap);
      expect(computeReconciliationAlarmTime(sql, env)).toBeNull();
    });

    it('reconsiders a deferred pre-runtime task after it becomes active', async () => {
      setupTaskSession();
      const taskRows: Record<string, MockTaskRow> = {
        'task-1': { task_mode: 'task', status: 'queued' },
      };
      const env = envWithRows(taskRows);

      expect(await getReconciliationCandidates(sql, env)).toEqual([]);

      taskRows['task-1']!.status = 'in_progress';
      vi.setSystemTime(now + 35_001);

      await expect(getReconciliationCandidates(sql, env)).resolves.toEqual([
        expect.objectContaining({ sessionId: 'session-1', taskId: 'task-1' }),
      ]);
    });

    it('scopes a permanent exclusion to the task binding', async () => {
      setupTaskSession();
      const taskRows: Record<string, MockTaskRow> = {
        'task-1': { task_mode: 'conversation', status: 'in_progress' },
        'task-2': {
          task_mode: 'task',
          status: 'in_progress',
          workspace_id: 'ws-1',
          chat_session_id: 'session-1',
        },
      };
      const env = envWithRows(taskRows);

      expect(await getReconciliationCandidates(sql, env)).toEqual([]);

      db.prepare(`UPDATE chat_sessions SET task_id = 'task-2' WHERE id = 'session-1'`).run();
      db.prepare(
        `UPDATE idle_cleanup_schedule SET task_id = 'task-2' WHERE session_id = 'session-1'`
      ).run();

      await expect(getReconciliationCandidates(sql, env)).resolves.toEqual([
        expect.objectContaining({ sessionId: 'session-1', taskId: 'task-2' }),
      ]);
    });

    it('does not stably exclude terminal evidence with an ambiguous task binding', async () => {
      setupTaskSession();
      const env = envWithRows({
        'task-1': {
          task_mode: 'task',
          status: 'completed',
          workspace_id: 'other-workspace',
          chat_session_id: 'session-1',
        },
      });

      expect(await getReconciliationCandidates(sql, env)).toEqual([]);

      const gate = db
        .prepare(`SELECT value FROM do_meta WHERE key = 'taskReconciliationGate:session-1'`)
        .get<{ value: string }>();
      expect(JSON.parse(gate!.value)).not.toHaveProperty('excludedTaskId');
      expect(computeReconciliationAlarmTime(sql, env)).not.toBeNull();
    });

    it('fails open from a malformed durable cursor', async () => {
      setupTaskSession();
      db.prepare(`INSERT INTO do_meta (key, value) VALUES (?, ?)`).run(
        'taskReconciliationCursor',
        '{not-json'
      );

      await expect(
        getReconciliationCandidates(
          sql,
          envWithRows({ 'task-1': { task_mode: 'task', status: 'in_progress' } })
        )
      ).resolves.toEqual([expect.objectContaining({ sessionId: 'session-1' })]);
    });

    it('excludes conversation-mode tasks', async () => {
      const candidates = await candidatesForTask('conversation', 'in_progress');
      expect(candidates).toHaveLength(0);
    });

    it('excludes completed tasks', async () => {
      const candidates = await candidatesForTask('task', 'completed');
      expect(candidates).toHaveLength(0);
    });

    it('excludes failed tasks', async () => {
      const candidates = await candidatesForTask('task', 'failed');
      expect(candidates).toHaveLength(0);
    });

    it('excludes sessions with active needs_input marker', async () => {
      setupTaskSession();
      createAttentionMarker(sql, {
        sessionId: 'session-1',
        taskId: 'task-1',
        workspaceId: 'ws-1',
        kind: 'needs_input',
        source: 'agent',
        reason: 'Waiting for user input',
        expiresAt: now + 7200000,
      });
      const candidates = await getReconciliationCandidates(
        sql,
        envWithRows({
          'task-1': { task_mode: 'task', status: 'in_progress' },
        })
      );
      expect(candidates).toHaveLength(0);
    });

    it('excludes sessions with unresolved reconciliation_checkin marker (loop prevention)', async () => {
      setupTaskSession();
      createAttentionMarker(sql, {
        sessionId: 'session-1',
        taskId: 'task-1',
        workspaceId: 'ws-1',
        kind: 'reconciliation_checkin',
        source: 'sam_orchestrator',
        reason: 'Agent idle — SAM check-in sent',
        expiresAt: now + ONE_MINUTE,
      });
      const candidates = await getReconciliationCandidates(
        sql,
        envWithRows({
          'task-1': { task_mode: 'task', status: 'in_progress' },
        })
      );
      expect(candidates).toHaveLength(0);
    });

    it('excludes sessions that are not idle long enough', async () => {
      // Activity 2 minutes ago — not idle for 5 minutes
      setupTaskSession({ lastActivityAt: now - 2 * 60 * 1000 });
      const mockDb = createMockD1({
        'task-1': { task_mode: 'task', status: 'in_progress' },
      });
      const env = {
        DATABASE: mockDb,
      } as unknown as import('../../../src/durable-objects/project-data/types').Env;

      const candidates = await getReconciliationCandidates(sql, env);
      expect(candidates).toHaveLength(0);
    });

    it('excludes sessions without an active ACP session', async () => {
      setupTaskSession();
      // Remove the ACP session
      db.exec('DELETE FROM acp_sessions');

      const mockDb = createMockD1({
        'task-1': { task_mode: 'task', status: 'in_progress' },
      });
      const env = {
        DATABASE: mockDb,
      } as unknown as import('../../../src/durable-objects/project-data/types').Env;

      const candidates = await getReconciliationCandidates(sql, env);
      expect(candidates).toHaveLength(0);
    });

    it('excludes sessions without a task_id in idle_cleanup_schedule', async () => {
      // Create a session without task_id (conversation mode)
      db.exec(
        `INSERT INTO chat_sessions (id, workspace_id, task_id, topic, status, message_count, started_at, created_at, updated_at)
         VALUES ('session-conv', 'ws-conv', NULL, 'Conv', 'active', 0, ${now}, ${now}, ${now})`
      );
      db.exec(
        `INSERT INTO idle_cleanup_schedule (session_id, workspace_id, task_id, cleanup_at, created_at, retry_count)
         VALUES ('session-conv', 'ws-conv', NULL, ${now + 900000}, ${now}, 0)`
      );

      const candidates = await getReconciliationCandidates(sql, envWithRows());
      expect(candidates).toHaveLength(0);
    });

    it('includes delegated tasks', async () => {
      const candidates = await candidatesForTask('task', 'delegated');
      expect(candidates).toHaveLength(1);
    });

    it('includes awaiting_followup tasks because they are not complete', async () => {
      const candidates = await candidatesForTask('task', 'awaiting_followup');
      expect(candidates).toHaveLength(1);
    });

    it('defers check-in while a task prompt is in flight below the soft threshold', async () => {
      setupTaskSession({ lastActivityAt: now - FIVE_MINUTES - 1000 });
      setSessionActivity({ promptStartedAt: now - 10 * 60 * 1000 });

      const candidates = await getReconciliationCandidates(sql, {
        ...envWithRows({ 'task-1': { task_mode: 'task', status: 'in_progress' } }),
        TASK_RECONCILIATION_PROMPT_SOFT_STALL_MS: String(THIRTY_MINUTES),
        TASK_RECONCILIATION_PROMPT_HARD_STALL_MS: String(TWO_HOURS),
      } as ProjectDataEnv);

      expect(candidates).toHaveLength(0);
    });

    it('observes but does not interrupt prompts between soft and hard thresholds', async () => {
      setupTaskSession({ lastActivityAt: now - FIVE_MINUTES - 1000 });
      setSessionActivity({ promptStartedAt: now - THIRTY_MINUTES - 1000 });

      const candidates = await getReconciliationCandidates(sql, {
        ...envWithRows({ 'task-1': { task_mode: 'task', status: 'in_progress' } }),
        TASK_RECONCILIATION_PROMPT_SOFT_STALL_MS: String(THIRTY_MINUTES),
        TASK_RECONCILIATION_PROMPT_HARD_STALL_MS: String(TWO_HOURS),
      } as ProjectDataEnv);

      expect(candidates).toHaveLength(1);
      expect(candidates[0]).toMatchObject({
        action: 'observe_prompt',
        promptStartedAt: now - THIRTY_MINUTES - 1000,
      });
      expect(candidates[0].promptAgeMs).toBe(THIRTY_MINUTES + 1000);
    });

    it('marks prompts beyond the hard threshold for cancellation', async () => {
      setupTaskSession({ lastActivityAt: now - FIVE_MINUTES - 1000 });
      setSessionActivity({ promptStartedAt: now - TWO_HOURS - 1000 });

      const candidates = await getReconciliationCandidates(sql, {
        ...envWithRows({ 'task-1': { task_mode: 'task', status: 'in_progress' } }),
        TASK_RECONCILIATION_PROMPT_SOFT_STALL_MS: String(THIRTY_MINUTES),
        TASK_RECONCILIATION_PROMPT_HARD_STALL_MS: String(TWO_HOURS),
      } as ProjectDataEnv);

      expect(candidates).toHaveLength(1);
      expect(candidates[0]).toMatchObject({
        action: 'cancel_prompt',
        promptStartedAt: now - TWO_HOURS - 1000,
      });
    });

    // REGRESSION (rule 50): session_state.activity_at has INTEGER affinity but
    // no STRICT typing, so a non-numeric value can land there (legacy row,
    // future migration bug, manual repair). Before the fix this was blindly
    // cast (`as SessionStateRow | undefined`) — the malformed string flowed
    // straight into `promptStartedAt`/`promptAgeMs` untyped, producing
    // `action: 'observe_prompt'` with a garbage (NaN-producing) promptStartedAt
    // instead of degrading safely. Seeded directly via SQL (real better-sqlite3
    // engine) because the application itself never writes a non-numeric
    // activity_at.
    it('treats a malformed session_state row as absent (degrades to checkin) instead of using a corrupted prompt state', async () => {
      setupTaskSession({ lastActivityAt: now - FIVE_MINUTES - 1000 });
      db.prepare(
        `INSERT INTO session_state (session_id, activity, activity_at, prompt_started_at, restart_count)
         VALUES (?, 'prompting', 'not-a-timestamp', NULL, 0)`
      ).run('acp-1');

      const candidates = await getReconciliationCandidates(
        sql,
        envWithRows({
          'task-1': { task_mode: 'task', status: 'in_progress' },
        })
      );

      expect(candidates).toHaveLength(1);
      expect(candidates[0]).toMatchObject({
        action: 'checkin',
        promptStartedAt: null,
        promptAgeMs: null,
      });
    });
  });

  describe('processReconciliationCandidates', () => {
    it('persists check-in message with SAM orchestrator metadata', async () => {
      setupTaskSession();
      const env = envWithRows(
        { 'task-1': { task_mode: 'task', status: 'in_progress' } },
        { 'ws-1': { node_id: 'node-1', user_id: 'user-1' } }
      );
      const broadcastEvent = vi.fn();

      const processed = await processReconciliationCandidates(sql, env, broadcastEvent);

      expect(processed).toBe(1);

      // Check the message was persisted
      const messages = db
        .prepare('SELECT * FROM chat_messages WHERE session_id = ?')
        .all('session-1');
      expect(messages).toHaveLength(1);
      const msg = messages[0] as Record<string, unknown>;
      expect(msg.role).toBe('user');
      expect(msg.content).toContain('SAM Orchestrator Check-In');
      expect(msg.content).toContain('continue working from where you left off');
      expect(msg.content).toContain('Do not stop after the update');
      expect(msg.content).toContain('complete_task()');

      // Check metadata
      const metadata = JSON.parse(msg.tool_metadata as string);
      expect(metadata.source).toBe('sam_orchestrator');
      expect(metadata.kind).toBe('reconciliation_checkin');
    });

    it('creates reconciliation_checkin attention marker with deadline', async () => {
      setupTaskSession();
      const env = envWithRows(
        { 'task-1': { task_mode: 'task', status: 'in_progress' } },
        { 'ws-1': { node_id: 'node-1', user_id: 'user-1' } }
      );
      const broadcastEvent = vi.fn();

      await processReconciliationCandidates(sql, env, broadcastEvent);

      // Check the attention marker was created
      const markers = db
        .prepare(
          `SELECT * FROM session_attention_markers WHERE session_id = ? AND kind = 'reconciliation_checkin'`
        )
        .all('session-1');
      expect(markers).toHaveLength(1);
      const marker = markers[0] as Record<string, unknown>;
      expect(marker.source).toBe('sam_orchestrator');
      expect(marker.resolved_at).toBeNull();
      // Expires ~1 minute from now
      expect(marker.expires_at).toBeGreaterThan(now);
      expect((marker.expires_at as number) - now).toBeLessThanOrEqual(ONE_MINUTE + 1000);
    });

    it('broadcasts message.new and attention.created events', async () => {
      setupTaskSession();
      const mockDb = createMockD1(
        { 'task-1': { task_mode: 'task', status: 'in_progress' } },
        { 'ws-1': { node_id: 'node-1', user_id: 'user-1' } }
      );
      const env = {
        DATABASE: mockDb,
      } as unknown as import('../../../src/durable-objects/project-data/types').Env;
      const broadcastEvent = vi.fn();

      await processReconciliationCandidates(sql, env, broadcastEvent);

      // Should broadcast message.new
      const msgEvents = broadcastEvent.mock.calls.filter(
        ([type]: string[]) => type === 'message.new'
      );
      expect(msgEvents).toHaveLength(1);
      expect(msgEvents[0][1].role).toBe('user');
      expect(msgEvents[0][1].toolMetadata.source).toBe('sam_orchestrator');

      // Should broadcast attention.created
      const attnEvents = broadcastEvent.mock.calls.filter(
        ([type]: string[]) => type === 'attention.created'
      );
      expect(attnEvents).toHaveLength(1);
      expect(attnEvents[0][1].kind).toBe('reconciliation_checkin');
    });

    it('records activity event for check-in', async () => {
      setupTaskSession();
      const mockDb = createMockD1(
        { 'task-1': { task_mode: 'task', status: 'in_progress' } },
        { 'ws-1': { node_id: 'node-1', user_id: 'user-1' } }
      );
      const env = {
        DATABASE: mockDb,
      } as unknown as import('../../../src/durable-objects/project-data/types').Env;
      const broadcastEvent = vi.fn();

      await processReconciliationCandidates(sql, env, broadcastEvent);

      const events = db
        .prepare(`SELECT * FROM activity_events WHERE event_type = 'reconciliation.checkin_sent'`)
        .all();
      expect(events).toHaveLength(1);
    });

    it('does not send duplicate check-in when marker already exists', async () => {
      setupTaskSession();
      // Create an existing unresolved reconciliation_checkin marker
      createAttentionMarker(sql, {
        sessionId: 'session-1',
        taskId: 'task-1',
        workspaceId: 'ws-1',
        kind: 'reconciliation_checkin',
        source: 'sam_orchestrator',
        expiresAt: now + ONE_MINUTE,
      });

      const mockDb = createMockD1({ 'task-1': { task_mode: 'task', status: 'in_progress' } });
      const env = {
        DATABASE: mockDb,
      } as unknown as import('../../../src/durable-objects/project-data/types').Env;
      const broadcastEvent = vi.fn();

      const processed = await processReconciliationCandidates(sql, env, broadcastEvent);
      expect(processed).toBe(0);
    });

    it('does not process when task already completed via complete_task', async () => {
      setupTaskSession();
      const mockDb = createMockD1({
        'task-1': { task_mode: 'task', status: 'completed' },
      });
      const env = {
        DATABASE: mockDb,
      } as unknown as import('../../../src/durable-objects/project-data/types').Env;
      const broadcastEvent = vi.fn();

      const processed = await processReconciliationCandidates(sql, env, broadcastEvent);
      expect(processed).toBe(0);
    });

    it('replays 01M1MJN41VG0Y964CTQ6S06Q4D: observe_prompt wins before suspect node resolution', async () => {
      const { cleanupTaskRun } = await import('../../../src/services/task-runner');
      const taskId = '01M1MJN41VG0Y964CTQ6S06Q4D';
      const sessionId = 'incident-observe-session';
      const workspaceId = 'incident-observe-workspace';
      const acpSessionId = 'incident-observe-acp';
      const promptStartedAt = Date.parse('2026-09-03T21:40:00.000Z');
      const nodeHeartbeatAt = Date.parse('2026-09-03T22:10:29.295Z');
      const observationAt = Date.parse('2026-09-03T22:13:05.000Z');
      const reconciliationAt = Date.parse('2026-09-03T22:15:29.000Z');

      vi.setSystemTime(observationAt);
      setupTaskSession({
        taskId,
        sessionId,
        workspaceId,
        acpSessionId,
        lastActivityAt: promptStartedAt,
      });
      setSessionActivity({ acpSessionId, activityAt: promptStartedAt, promptStartedAt });
      setAcpHeartbeat(acpSessionId, nodeHeartbeatAt);

      const taskRows = {
        [taskId]: {
          task_mode: 'task',
          status: 'in_progress',
          project_id: 'project-1',
          workspace_id: workspaceId,
          chat_session_id: sessionId,
        },
      } satisfies Record<string, MockTaskRow>;
      const env = {
        ...envWithRows(taskRows, {
          [workspaceId]: {
            node_id: 'incident-node',
            user_id: 'user-1',
            project_id: 'project-1',
            health_status: 'unhealthy',
            last_heartbeat_at: new Date(nodeHeartbeatAt).toISOString(),
          },
        }),
        TASK_RECONCILIATION_PROMPT_SOFT_STALL_MS: String(THIRTY_MINUTES),
        TASK_RECONCILIATION_PROMPT_HARD_STALL_MS: String(TWO_HOURS),
      } as ProjectDataEnv;

      expect(await processReconciliationCandidates(sql, env, vi.fn())).toBe(1);
      vi.setSystemTime(reconciliationAt);
      expect(await processReconciliationCandidates(sql, env, vi.fn())).toBe(0);

      expect(
        db
          .prepare(
            `SELECT created_at FROM activity_events
             WHERE event_type = 'reconciliation.prompt_in_flight_observed' AND task_id = ?`
          )
          .all(taskId)
      ).toEqual([expect.objectContaining({ created_at: observationAt })]);
      expect(db.prepare('SELECT status FROM chat_sessions WHERE id = ?').get(sessionId)).toEqual({
        status: 'active',
      });
      expect(taskRows[taskId].status).toBe('in_progress');
      expect(db.prepare('SELECT * FROM chat_messages WHERE session_id = ?').all(sessionId)).toEqual(
        []
      );
      expect(
        db.prepare('SELECT * FROM session_attention_markers WHERE session_id = ?').all(sessionId)
      ).toEqual([]);
      expect(vi.mocked(cleanupTaskRun)).not.toHaveBeenCalled();
    });

    it('records observe_prompt before a suspended workspace resolution completes', async () => {
      setupTaskSession();
      setSessionActivity({ promptStartedAt: now - THIRTY_MINUTES - 1000 });
      const mockDb = createMockD1(
        { 'task-1': { task_mode: 'task', status: 'in_progress' } },
        { 'ws-1': { node_id: 'node-1', user_id: 'user-1' } }
      );
      const prepareMock = vi.mocked(mockDb.prepare);
      const basePrepare = prepareMock.getMockImplementation()!;
      let rejectWorkspace!: (reason: Error) => void;
      prepareMock.mockImplementation((query: string) => {
        if (!query.includes('FROM workspaces')) return basePrepare(query);
        return {
          bind: vi.fn().mockReturnValue({
            first: vi.fn().mockReturnValue(
              new Promise((_resolve, reject) => {
                rejectWorkspace = reject;
              })
            ),
          }),
        } as unknown as D1PreparedStatement;
      });
      const env = {
        DATABASE: mockDb,
        TASK_RECONCILIATION_PROMPT_SOFT_STALL_MS: String(THIRTY_MINUTES),
        TASK_RECONCILIATION_PROMPT_HARD_STALL_MS: String(TWO_HOURS),
      } as unknown as ProjectDataEnv;
      const waitUntilPromises: Promise<unknown>[] = [];

      expect(
        await processReconciliationCandidates(sql, env, vi.fn(), {
          waitUntil: (promise) => waitUntilPromises.push(promise),
        })
      ).toBe(1);
      expect(
        db
          .prepare(
            `SELECT COUNT(*) AS count FROM activity_events
             WHERE event_type = 'reconciliation.prompt_in_flight_observed'`
          )
          .get<{ count: number }>()!.count
      ).toBe(1);
      expect(waitUntilPromises).toHaveLength(1);

      rejectWorkspace(new Error('suspended workspace lookup released'));
      await waitUntilPromises[0];
    });

    it('replays 01M1M75WA3V528VYZCWQGGM3NT: the live prompt survives the exact stale-mirror sequence', async () => {
      const { cleanupTaskRun } = await import('../../../src/services/task-runner');
      const taskId = '01M1M75WA3V528VYZCWQGGM3NT';
      const sessionId = 'incident-long-prompt-session';
      const workspaceId = 'incident-long-prompt-workspace';
      const acpSessionId = 'incident-long-prompt-acp';
      const promptStartedAt = Date.parse('2026-09-03T22:02:15.000Z');
      const staleMirrorObservedAt = Date.parse('2026-09-03T22:15:48.823Z');
      const nodeHeartbeatSuspectAt = Date.parse('2026-09-03T22:15:48.965Z');
      const promptFailureObservedAt = Date.parse('2026-09-03T22:44:48.341Z');
      const promptStillLiveAt = promptFailureObservedAt - 1;

      vi.setSystemTime(staleMirrorObservedAt);
      setupTaskSession({
        taskId,
        sessionId,
        workspaceId,
        acpSessionId,
        lastActivityAt: promptStartedAt,
      });
      setSessionActivity({ acpSessionId, activityAt: promptStartedAt, promptStartedAt });
      const taskRows = {
        [taskId]: {
          task_mode: 'task',
          status: 'in_progress',
          project_id: 'project-1',
          workspace_id: workspaceId,
          chat_session_id: sessionId,
        },
      } satisfies Record<string, MockTaskRow>;
      const env = {
        ...envWithRows(taskRows, {
          [workspaceId]: {
            node_id: 'incident-node',
            user_id: 'user-1',
            project_id: 'project-1',
            health_status: 'unhealthy',
            last_heartbeat_at: new Date(promptStartedAt).toISOString(),
          },
        }),
        TASK_RECONCILIATION_PROMPT_SOFT_STALL_MS: String(THIRTY_MINUTES),
        TASK_RECONCILIATION_PROMPT_HARD_STALL_MS: String(TWO_HOURS),
      } as ProjectDataEnv;

      expect(await processReconciliationCandidates(sql, env, vi.fn())).toBe(0);
      vi.setSystemTime(nodeHeartbeatSuspectAt);
      expect(await processReconciliationCandidates(sql, env, vi.fn())).toBe(0);
      vi.setSystemTime(promptStillLiveAt);
      expect(await processReconciliationCandidates(sql, env, vi.fn())).toBe(1);

      expect(
        db.prepare('SELECT activity FROM session_state WHERE session_id = ?').get(acpSessionId)
      ).toEqual({
        activity: 'prompting',
      });
      expect(db.prepare('SELECT status FROM chat_sessions WHERE id = ?').get(sessionId)).toEqual({
        status: 'active',
      });
      expect(taskRows[taskId].status).toBe('in_progress');
      expect(db.prepare('SELECT * FROM chat_messages WHERE session_id = ?').all(sessionId)).toEqual(
        []
      );
      expect(
        db.prepare('SELECT * FROM session_attention_markers WHERE session_id = ?').all(sessionId)
      ).toEqual([]);
      expect(vi.mocked(cleanupTaskRun)).not.toHaveBeenCalled();
    });

    it('uses the configured node-call timeout for check-in delivery', async () => {
      const { sendPromptToAgentOnNode } = await import('../../../src/services/node-agent');
      setupTaskSession();
      const mockDb = createMockD1(
        { 'task-1': { task_mode: 'task', status: 'in_progress' } },
        { 'ws-1': { node_id: 'node-1', user_id: 'user-1' } }
      );
      const env = {
        DATABASE: mockDb,
        TASK_RECONCILIATION_NODE_CALL_TIMEOUT_MS: '1234',
      } as unknown as import('../../../src/durable-objects/project-data/types').Env;
      const broadcastEvent = vi.fn();

      await processReconciliationCandidates(sql, env, broadcastEvent);

      expect(vi.mocked(sendPromptToAgentOnNode)).toHaveBeenCalledWith(
        'node-1',
        'ws-1',
        'acp-1',
        expect.stringContaining('continue working from where you left off'),
        expect.anything(),
        'user-1',
        expect.any(String),
        expect.objectContaining({
          requestTimeoutMs: 1234,
          protocolVersion: 1,
          deliveryId: expect.any(String),
        })
      );
    });

    it('does not create a marker or message when agent delivery fails', async () => {
      const { sendPromptToAgentOnNode } = await import('../../../src/services/node-agent');
      vi.mocked(sendPromptToAgentOnNode).mockRejectedValueOnce(new Error('network error'));

      setupTaskSession();
      const mockDb = createMockD1(
        { 'task-1': { task_mode: 'task', status: 'in_progress' } },
        { 'ws-1': { node_id: 'node-1', user_id: 'user-1' } }
      );
      const env = {
        DATABASE: mockDb,
      } as unknown as import('../../../src/durable-objects/project-data/types').Env;
      const broadcastEvent = vi.fn();

      const processed = await processReconciliationCandidates(sql, env, broadcastEvent);
      expect(processed).toBe(0);

      const messages = db
        .prepare('SELECT * FROM chat_messages WHERE session_id = ?')
        .all('session-1');
      expect(messages).toHaveLength(0);

      const markers = db
        .prepare(
          `SELECT * FROM session_attention_markers WHERE session_id = ? AND kind = 'reconciliation_checkin'`
        )
        .all('session-1');
      expect(markers).toHaveLength(0);
    });

    it('reuses receipt and transcript identities after acceptance precedes a marker write failure', async () => {
      const { sendPromptToAgentOnNode } = await import('../../../src/services/node-agent');
      const executedDeliveryIds = new Set<string>();
      let promptExecutions = 0;
      vi.mocked(sendPromptToAgentOnNode).mockImplementation(async (...args) => {
        const acpSessionId = args[2];
        const deliveryId = args[7]?.deliveryId ?? '';
        const duplicate = executedDeliveryIds.has(deliveryId);
        if (!duplicate) {
          executedDeliveryIds.add(deliveryId);
          promptExecutions += 1;
        }
        return {
          status: duplicate ? 'duplicate' : 'accepted',
          sessionId: acpSessionId,
          receipt: {
            deliveryId,
            state: 'accepted',
            runtimeIdentity: nodeAgentMocks.runtimeIdentity,
            acceptedAt: now,
            completedAt: null,
          },
        };
      });

      setupTaskSession();
      db.exec(
        `CREATE TRIGGER reject_first_reconciliation_marker
         BEFORE INSERT ON session_attention_markers
         WHEN NEW.kind = 'reconciliation_checkin'
         BEGIN
           SELECT RAISE(FAIL, 'simulated marker write failure');
         END`
      );
      const env = {
        ...envWithRows(
          { 'task-1': { task_mode: 'task', status: 'in_progress' } },
          { 'ws-1': { node_id: 'node-1', user_id: 'user-1' } }
        ),
        TASK_RECONCILIATION_CANDIDATE_LEASE_MS: '1',
        TASK_LIVENESS_NODE_HEALTH_PROBE_TIMEOUT_MS: '1',
        TASK_LIVENESS_PROBE_TIMEOUT_MS: '1',
        TASK_RECONCILIATION_NODE_CALL_TIMEOUT_MS: '1',
        TASK_RECONCILIATION_MIN_ALARM_DELAY_MS: '1',
      } as ProjectDataEnv;
      const broadcastEvent = vi.fn();

      expect(await processReconciliationCandidates(sql, env, broadcastEvent)).toBe(0);
      expect(
        db.prepare(`SELECT COUNT(*) AS count FROM chat_messages`).get<{ count: number }>()!.count
      ).toBe(1);
      expect(
        db
          .prepare(`SELECT COUNT(*) AS count FROM session_attention_markers`)
          .get<{ count: number }>()!.count
      ).toBe(0);

      db.exec('DROP TRIGGER reject_first_reconciliation_marker');
      vi.setSystemTime(now + 7);
      expect(await processReconciliationCandidates(sql, env, broadcastEvent)).toBe(1);

      const submitCalls = vi.mocked(sendPromptToAgentOnNode).mock.calls;
      expect(submitCalls).toHaveLength(2);
      expect(submitCalls[1]?.[6]).toBe(submitCalls[0]?.[6]);
      expect(submitCalls[1]?.[7]?.deliveryId).toBe(submitCalls[0]?.[7]?.deliveryId);
      expect(promptExecutions).toBe(1);
      expect(
        db.prepare(`SELECT COUNT(*) AS count FROM chat_messages`).get<{ count: number }>()!.count
      ).toBe(1);
      expect(
        db
          .prepare(`SELECT COUNT(*) AS count FROM session_attention_markers`)
          .get<{ count: number }>()!.count
      ).toBe(1);
      expect(broadcastEvent.mock.calls.filter(([type]) => type === 'message.new')).toHaveLength(1);
    });

    it('fails dead-node candidates without attempting VM delivery', async () => {
      const { sendPromptToAgentOnNode, cancelAgentSessionOnNode } =
        await import('../../../src/services/node-agent');
      setupTaskSession();
      const mockDb = createMockD1(
        { 'task-1': { task_mode: 'task', status: 'in_progress' } },
        {
          'ws-1': {
            node_id: 'node-1',
            user_id: 'user-1',
            project_id: 'project-1',
            node_status: 'destroyed',
            health_status: 'unhealthy',
            last_heartbeat_at: null,
          },
        }
      );
      const env = { DATABASE: mockDb } as unknown as ProjectDataEnv;
      const broadcastEvent = vi.fn();

      const processed = await processReconciliationCandidates(sql, env, broadcastEvent, {
        projectId: 'project-1',
      });

      expect(processed).toBe(1);
      expect(vi.mocked(sendPromptToAgentOnNode)).not.toHaveBeenCalled();
      expect(vi.mocked(cancelAgentSessionOnNode)).not.toHaveBeenCalled();
      expect(
        db.prepare(`SELECT status FROM chat_sessions WHERE id = 'session-1'`).get()
      ).toMatchObject({
        status: 'failed',
      });
      expect(
        db.prepare(`SELECT * FROM chat_messages WHERE session_id = 'session-1'`).all()
      ).toHaveLength(0);
      const runCalls = (
        mockDb as unknown as { __runCalls: Array<{ query: string; args: unknown[] }> }
      ).__runCalls;
      expect(runCalls).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            query: expect.stringContaining('AND project_id = ?'),
            args: expect.arrayContaining(['task-1', 'project-1']),
          }),
          expect.objectContaining({
            query: expect.stringContaining('AND project_id = ?'),
            args: expect.arrayContaining(['ws-1', 'project-1']),
          }),
        ])
      );
    });

    it('converges explicit terminal ownership through one transition and one cleanup', async () => {
      const { cleanupTaskRun } = await import('../../../src/services/task-runner');
      setupTaskSession();
      const mockDb = createMockD1(
        { 'task-1': { task_mode: 'task', status: 'in_progress' } },
        {
          'ws-1': {
            node_id: 'node-1',
            user_id: 'user-1',
            status: 'stopped',
          },
        }
      );
      const env = { DATABASE: mockDb } as unknown as ProjectDataEnv;
      const waitUntilPromises: Promise<unknown>[] = [];
      const hooks = {
        projectId: 'project-1',
        waitUntil: (promise: Promise<unknown>) => waitUntilPromises.push(promise),
      };

      expect(await processReconciliationCandidates(sql, env, vi.fn(), hooks)).toBe(0);
      await Promise.all(waitUntilPromises.splice(0));
      expect(await processReconciliationCandidates(sql, env, vi.fn(), hooks)).toBe(0);
      await Promise.all(waitUntilPromises.splice(0));

      expect(vi.mocked(cleanupTaskRun)).toHaveBeenCalledTimes(1);
      expect(
        (mockDb as unknown as { __statusEvents: Array<Record<string, unknown>> }).__statusEvents
      ).toHaveLength(1);
      expect(
        db
          .prepare(
            `SELECT COUNT(*) AS count FROM activity_events
             WHERE event_type = 'reconciliation.dead_target_failed'`
          )
          .get<{ count: number }>()!.count
      ).toBe(1);
      expect(db.prepare(`SELECT status FROM chat_sessions WHERE id = 'session-1'`).get()).toEqual({
        status: 'failed',
      });
    });

    // Rule 44 (enumerate every writer of the migrated data): this path calls
    // `sessions.failSession`, so it mutates `chat_sessions` exactly like the
    // other terminal writers — but its hooks object carried no sync callback, so
    // the D1 `session_summaries` index went on reporting the session as active
    // until some unrelated write happened to resync the whole project. It was
    // the only chat_sessions writer with no sync hook.
    it('schedules a D1 session-index resync when it terminally fails a dead target', async () => {
      setupTaskSession();
      const env = envWithRows(
        { 'task-1': { task_mode: 'task', status: 'in_progress' } },
        { 'ws-1': { node_id: 'node-1', user_id: 'user-1', status: 'stopped' } }
      );
      const scheduleSummarySync = vi.fn();

      const processed = await processReconciliationCandidates(sql, env, vi.fn(), {
        projectId: 'project-1',
        scheduleSummarySync,
      });

      expect(processed).toBe(1);
      // The session really was terminalized — otherwise the sync assertion below
      // would pass for a path that did nothing.
      expect(
        db.prepare(`SELECT status FROM chat_sessions WHERE id = 'session-1'`).get()
      ).toMatchObject({ status: 'failed' });
      expect(scheduleSummarySync).toHaveBeenCalled();
    });

    it('does not require a sync hook to terminally fail a dead target', async () => {
      // The hook is optional so existing callers (and tests) keep working; a
      // missing hook must not throw and take the reconciliation down with it.
      setupTaskSession();
      const env = envWithRows(
        { 'task-1': { task_mode: 'task', status: 'in_progress' } },
        { 'ws-1': { node_id: 'node-1', user_id: 'user-1', status: 'stopped' } }
      );

      await expect(
        processReconciliationCandidates(sql, env, vi.fn(), { projectId: 'project-1' })
      ).resolves.toBe(1);
      expect(
        db.prepare(`SELECT status FROM chat_sessions WHERE id = 'session-1'`).get()
      ).toMatchObject({ status: 'failed' });
    });

    it('preserves a running workspace whose delivery identity is incomplete', async () => {
      const { sendPromptToAgentOnNode } = await import('../../../src/services/node-agent');
      setupTaskSession();
      const env = envWithRows(
        { 'task-1': { task_mode: 'task', status: 'in_progress' } },
        { 'ws-1': { node_id: null, user_id: 'user-1' } }
      );

      const firstPass = await processReconciliationCandidates(sql, env, vi.fn());
      const secondPass = await processReconciliationCandidates(sql, env, vi.fn());

      expect(firstPass).toBe(0);
      expect(secondPass).toBe(0);
      expect(vi.mocked(sendPromptToAgentOnNode)).not.toHaveBeenCalled();
      expect(
        db.prepare(`SELECT status FROM chat_sessions WHERE id = 'session-1'`).get()
      ).toMatchObject({ status: 'active' });
    });

    it('quarantines repeated unreachable liveness without a deadline or failure marker', async () => {
      setupTaskSession();
      const mockDb = createMockD1(
        { 'task-1': { task_mode: 'task', status: 'in_progress' } },
        { 'ws-1': { node_id: null, user_id: 'user-1' } }
      );
      const env = {
        DATABASE: mockDb,
        TASK_RECONCILIATION_CANDIDATE_LEASE_MS: '1000',
        TASK_RECONCILIATION_PROBE_MAX_ATTEMPTS: '2',
        TASK_RECONCILIATION_QUARANTINE_MS: String(FIVE_MINUTES),
        TASK_LIVENESS_NODE_HEALTH_PROBE_TIMEOUT_MS: '1',
        TASK_LIVENESS_PROBE_TIMEOUT_MS: '1',
        TASK_RECONCILIATION_NODE_CALL_TIMEOUT_MS: '1',
        TASK_RECONCILIATION_MIN_ALARM_DELAY_MS: '1',
      } as unknown as ProjectDataEnv;

      expect(await processReconciliationCandidates(sql, env, vi.fn())).toBe(0);
      vi.setSystemTime(now + 1001);
      expect(await processReconciliationCandidates(sql, env, vi.fn())).toBe(0);
      vi.setSystemTime(now + 2002);
      expect(await processReconciliationCandidates(sql, env, vi.fn())).toBe(0);

      const workspaceReads = vi
        .mocked(mockDb.prepare)
        .mock.calls.filter(([query]) => String(query).includes('FROM workspaces'));
      expect(workspaceReads).toHaveLength(2);
      expect(
        db
          .prepare(
            `SELECT COUNT(*) AS count FROM activity_events
             WHERE event_type = 'reconciliation.candidate_quarantined'`
          )
          .get<{ count: number }>()!.count
      ).toBe(1);
      expect(
        db.prepare(`SELECT COUNT(*) AS count FROM session_attention_markers`).get<{
          count: number;
        }>()!.count
      ).toBe(0);
      expect(db.prepare(`SELECT status FROM chat_sessions WHERE id = 'session-1'`).get()).toEqual({
        status: 'active',
      });
    });

    it('records local observation but performs no remote work without durable project identity', async () => {
      setupTaskSession();
      setSessionActivity({ promptStartedAt: now - THIRTY_MINUTES - 1000 });
      const mockDb = createMockD1(
        { 'task-1': { task_mode: 'task', status: 'in_progress' } },
        { 'ws-1': { node_id: 'node-1', user_id: 'user-1' } }
      );
      const waitUntilPromises: Promise<unknown>[] = [];

      expect(
        await processReconciliationCandidates(
          sql,
          { DATABASE: mockDb } as unknown as ProjectDataEnv,
          vi.fn(),
          {
            projectId: null,
            waitUntil: (promise) => waitUntilPromises.push(promise),
          }
        )
      ).toBe(1);
      await waitUntilPromises[0];

      expect(
        vi
          .mocked(mockDb.prepare)
          .mock.calls.filter(([query]) => String(query).includes('FROM workspaces'))
      ).toHaveLength(0);
      expect(
        db
          .prepare(
            `SELECT COUNT(*) AS count FROM activity_events
             WHERE event_type = 'reconciliation.prompt_in_flight_observed'`
          )
          .get<{ count: number }>()!.count
      ).toBe(1);
      expect(db.prepare('SELECT status FROM chat_sessions WHERE id = ?').get('session-1')).toEqual({
        status: 'active',
      });
    });

    it('does not resolve runtime state across a task workspace/chat identity mismatch', async () => {
      setupTaskSession();
      const mockDb = createMockD1({
        'task-1': {
          task_mode: 'task',
          status: 'in_progress',
          workspace_id: 'other-workspace',
          chat_session_id: 'other-chat',
        },
      });

      expect(
        await processReconciliationCandidates(
          sql,
          { DATABASE: mockDb } as unknown as ProjectDataEnv,
          vi.fn()
        )
      ).toBe(0);
      expect(
        vi
          .mocked(mockDb.prepare)
          .mock.calls.filter(([query]) => String(query).includes('FROM workspaces'))
      ).toHaveLength(0);
      expect(db.prepare('SELECT status FROM chat_sessions WHERE id = ?').get('session-1')).toEqual({
        status: 'active',
      });
    });

    it('terminally handles dead-node observe and cancel candidates without touching unrelated newer sessions', async () => {
      const { sendPromptToAgentOnNode, cancelAgentSessionOnNode } =
        await import('../../../src/services/node-agent');
      setupTaskSession({
        sessionId: 'observe-session',
        workspaceId: 'observe-ws',
        taskId: 'observe-task',
        acpSessionId: 'observe-acp',
      });
      setSessionActivity({
        acpSessionId: 'observe-acp',
        promptStartedAt: now - THIRTY_MINUTES - 1000,
      });
      setupTaskSession({
        sessionId: 'cancel-session',
        workspaceId: 'cancel-ws',
        taskId: 'cancel-task',
        acpSessionId: 'cancel-acp',
      });
      setSessionActivity({
        acpSessionId: 'cancel-acp',
        promptStartedAt: now - TWO_HOURS - 1000,
      });
      setupTaskSession({
        sessionId: 'newer-session',
        workspaceId: 'newer-ws',
        taskId: 'newer-task',
        acpSessionId: 'newer-acp',
        lastActivityAt: now - 1000,
      });
      const env = {
        ...envWithRows(
          {
            'observe-task': { task_mode: 'task', status: 'in_progress' },
            'cancel-task': { task_mode: 'task', status: 'in_progress' },
            'newer-task': { task_mode: 'task', status: 'in_progress' },
          },
          {
            'observe-ws': {
              node_id: 'dead-node-1',
              user_id: 'user-1',
              node_status: 'running',
              health_status: 'healthy',
              last_heartbeat_at: new Date(now - 10 * 60 * 1000).toISOString(),
            },
            'cancel-ws': {
              node_id: 'dead-node-2',
              user_id: 'user-1',
              node_status: 'destroyed',
              health_status: 'unhealthy',
              last_heartbeat_at: null,
            },
            'newer-ws': { node_id: 'healthy-node', user_id: 'user-1' },
          }
        ),
        TASK_RECONCILIATION_PROMPT_SOFT_STALL_MS: String(THIRTY_MINUTES),
        TASK_RECONCILIATION_PROMPT_HARD_STALL_MS: String(TWO_HOURS),
      } as ProjectDataEnv;

      const firstPass = await processReconciliationCandidates(sql, env, vi.fn());
      const secondPass = await processReconciliationCandidates(sql, env, vi.fn());

      expect(firstPass).toBe(2);
      expect(secondPass).toBe(0);
      expect(vi.mocked(sendPromptToAgentOnNode)).not.toHaveBeenCalled();
      expect(vi.mocked(cancelAgentSessionOnNode)).not.toHaveBeenCalled();
      expect(
        db.prepare(`SELECT status FROM chat_sessions WHERE id = 'observe-session'`).get()
      ).toMatchObject({ status: 'active' });
      expect(
        db.prepare(`SELECT status FROM chat_sessions WHERE id = 'cancel-session'`).get()
      ).toMatchObject({
        status: 'failed',
      });
      expect(
        db.prepare(`SELECT status FROM chat_sessions WHERE id = 'newer-session'`).get()
      ).toMatchObject({
        status: 'active',
      });
    });

    it('clamps the candidate lease across waitUntil delivery and persists only after acceptance', async () => {
      const { sendPromptToAgentOnNode } = await import('../../../src/services/node-agent');
      let acceptDelivery!: () => void;
      vi.mocked(sendPromptToAgentOnNode).mockImplementationOnce((...args) => {
        const acpSessionId = args[2];
        const deliveryId = args[7]?.deliveryId;
        return new Promise((resolve) => {
          acceptDelivery = () =>
            resolve({
              status: 'accepted',
              sessionId: acpSessionId,
              receipt: {
                deliveryId,
                state: 'accepted',
                runtimeIdentity: nodeAgentMocks.runtimeIdentity,
                acceptedAt: Date.now(),
                completedAt: null,
              },
            });
        });
      });
      setupTaskSession();
      const env = {
        ...envWithRows(
          { 'task-1': { task_mode: 'task', status: 'in_progress' } },
          { 'ws-1': { node_id: 'node-1', user_id: 'user-1' } }
        ),
        TASK_RECONCILIATION_CANDIDATE_LEASE_MS: '1',
        TASK_LIVENESS_NODE_HEALTH_PROBE_TIMEOUT_MS: '1000',
        TASK_LIVENESS_PROBE_TIMEOUT_MS: '1000',
        TASK_RECONCILIATION_NODE_CALL_TIMEOUT_MS: '1000',
        TASK_RECONCILIATION_MIN_ALARM_DELAY_MS: '1000',
      } as ProjectDataEnv;
      const waitUntilPromises: Promise<unknown>[] = [];

      const processed = await processReconciliationCandidates(sql, env, vi.fn(), {
        waitUntil: (promise) => waitUntilPromises.push(promise),
      });

      expect(processed).toBe(0);
      expect(waitUntilPromises).toHaveLength(1);
      await vi.waitFor(() => {
        expect(vi.mocked(sendPromptToAgentOnNode)).toHaveBeenCalledTimes(1);
      });
      const gate = db
        .prepare(`SELECT value FROM do_meta WHERE key = 'taskReconciliationGate:session-1'`)
        .get<{ value: string }>();
      expect(JSON.parse(gate!.value)).toMatchObject({ nextAttemptAt: now + 6000 });
      vi.setSystemTime(now + 5500);
      // A second alarm can run while the first waitUntil delivery is still in
      // flight. Even after the max-of-probes lease would have expired, the
      // effective value still covers every configured probe and delivery budget.
      expect(
        await processReconciliationCandidates(sql, env, vi.fn(), {
          waitUntil: (promise) => waitUntilPromises.push(promise),
        })
      ).toBe(0);
      expect(vi.mocked(sendPromptToAgentOnNode)).toHaveBeenCalledTimes(1);
      expect(waitUntilPromises).toHaveLength(1);
      expect(
        db
          .prepare(
            `SELECT COUNT(*) AS count FROM session_attention_markers WHERE kind = 'reconciliation_checkin'`
          )
          .get<{ count: number }>()!.count
      ).toBe(0);

      acceptDelivery();
      await expect(waitUntilPromises[0]).resolves.toEqual([
        expect.objectContaining({ status: 'fulfilled', value: 1 }),
      ]);
      expect(
        db
          .prepare(
            `SELECT COUNT(*) AS count FROM session_attention_markers WHERE kind = 'reconciliation_checkin'`
          )
          .get<{ count: number }>()!.count
      ).toBe(1);
    });

    it('processes multiple concurrent candidates independently', async () => {
      // Set up two idle task-mode sessions
      setupTaskSession({
        sessionId: 'session-1',
        workspaceId: 'ws-1',
        taskId: 'task-1',
        acpSessionId: 'acp-1',
      });
      setupTaskSession({
        sessionId: 'session-2',
        workspaceId: 'ws-2',
        taskId: 'task-2',
        acpSessionId: 'acp-2',
      });

      const mockDb = createMockD1(
        {
          'task-1': { task_mode: 'task', status: 'in_progress' },
          'task-2': { task_mode: 'task', status: 'in_progress' },
        },
        {
          'ws-1': { node_id: 'node-1', user_id: 'user-1' },
          'ws-2': { node_id: 'node-2', user_id: 'user-2' },
        }
      );
      const env = {
        DATABASE: mockDb,
      } as unknown as import('../../../src/durable-objects/project-data/types').Env;
      const broadcastEvent = vi.fn();

      const processed = await processReconciliationCandidates(sql, env, broadcastEvent);
      expect(processed).toBe(2);

      // Each session should have its own message and marker
      const msgs1 = db.prepare('SELECT * FROM chat_messages WHERE session_id = ?').all('session-1');
      const msgs2 = db.prepare('SELECT * FROM chat_messages WHERE session_id = ?').all('session-2');
      expect(msgs1).toHaveLength(1);
      expect(msgs2).toHaveLength(1);

      const markers = db
        .prepare(
          `SELECT * FROM session_attention_markers WHERE kind = 'reconciliation_checkin' AND resolved_at IS NULL`
        )
        .all();
      expect(markers).toHaveLength(2);
    });

    it('caps each sweep and processes the capped batch in parallel', async () => {
      const { cancelAgentSessionOnNode } = await import('../../../src/services/node-agent');
      const resolvers: Array<() => void> = [];
      let inFlight = 0;
      let maxInFlight = 0;
      vi.mocked(cancelAgentSessionOnNode).mockImplementation(async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise<void>((resolve) => {
          resolvers.push(() => {
            inFlight--;
            resolve();
          });
        });
        return { success: true, status: 200 };
      });

      const taskRows: Record<string, { task_mode: string; status: string }> = {};
      const workspaceRows: Record<string, { node_id: string | null; user_id: string }> = {};
      for (let i = 1; i <= 4; i++) {
        setupTaskSession({
          sessionId: `session-${i}`,
          workspaceId: `ws-${i}`,
          taskId: `task-${i}`,
          acpSessionId: `acp-${i}`,
        });
        setSessionActivity({ acpSessionId: `acp-${i}`, promptStartedAt: now - TWO_HOURS - 1000 });
        taskRows[`task-${i}`] = { task_mode: 'task', status: 'in_progress' };
        workspaceRows[`ws-${i}`] = { node_id: `node-${i}`, user_id: `user-${i}` };
      }
      const env = {
        ...envWithRows(taskRows, workspaceRows),
        TASK_RECONCILIATION_PROMPT_SOFT_STALL_MS: String(THIRTY_MINUTES),
        TASK_RECONCILIATION_PROMPT_HARD_STALL_MS: String(TWO_HOURS),
        TASK_RECONCILIATION_MAX_CANDIDATES_PER_SWEEP: '2',
      } as ProjectDataEnv;

      const processing = processReconciliationCandidates(sql, env, vi.fn());
      await vi.waitFor(() => {
        expect(vi.mocked(cancelAgentSessionOnNode)).toHaveBeenCalledTimes(2);
      });

      expect(maxInFlight).toBe(2);
      for (const resolve of resolvers) resolve();
      await expect(processing).resolves.toBe(2);
      vi.mocked(cancelAgentSessionOnNode).mockResolvedValue({ success: true, status: 200 });
    });

    it('does not create a visible check-in for an in-flight prompt below the hard threshold', async () => {
      const { cancelAgentSessionOnNode, sendPromptToAgentOnNode } =
        await import('../../../src/services/node-agent');
      setupTaskSession({ lastActivityAt: now - FIVE_MINUTES - 1000 });
      setSessionActivity({ promptStartedAt: now - THIRTY_MINUTES - 1000 });
      const env = {
        ...envWithRows(
          { 'task-1': { task_mode: 'task', status: 'in_progress' } },
          { 'ws-1': { node_id: 'node-1', user_id: 'user-1' } }
        ),
        TASK_RECONCILIATION_PROMPT_SOFT_STALL_MS: String(THIRTY_MINUTES),
        TASK_RECONCILIATION_PROMPT_HARD_STALL_MS: String(TWO_HOURS),
      } as ProjectDataEnv;
      const broadcastEvent = vi.fn();

      const processed = await processReconciliationCandidates(sql, env, broadcastEvent);

      expect(processed).toBe(1);
      expect(vi.mocked(sendPromptToAgentOnNode)).not.toHaveBeenCalled();
      expect(vi.mocked(cancelAgentSessionOnNode)).not.toHaveBeenCalled();
      expect(
        db.prepare('SELECT * FROM chat_messages WHERE session_id = ?').all('session-1')
      ).toHaveLength(0);
      expect(
        db
          .prepare(`SELECT * FROM session_attention_markers WHERE kind = 'reconciliation_checkin'`)
          .all()
      ).toHaveLength(0);
      expect(
        db
          .prepare(
            `SELECT * FROM activity_events WHERE event_type = 'reconciliation.prompt_in_flight_observed'`
          )
          .all()
      ).toHaveLength(1);
    });

    it('requests prompt cancellation before creating any check-in marker for hard-stalled prompts', async () => {
      const { cancelAgentSessionOnNode, sendPromptToAgentOnNode } =
        await import('../../../src/services/node-agent');
      setupTaskSession({ lastActivityAt: now - FIVE_MINUTES - 1000 });
      setSessionActivity({ promptStartedAt: now - TWO_HOURS - 1000 });
      const env = {
        ...envWithRows(
          { 'task-1': { task_mode: 'task', status: 'in_progress' } },
          { 'ws-1': { node_id: 'node-1', user_id: 'user-1' } }
        ),
        TASK_RECONCILIATION_PROMPT_SOFT_STALL_MS: String(THIRTY_MINUTES),
        TASK_RECONCILIATION_PROMPT_HARD_STALL_MS: String(TWO_HOURS),
        TASK_RECONCILIATION_NODE_CALL_TIMEOUT_MS: '2345',
      } as ProjectDataEnv;
      const broadcastEvent = vi.fn();

      const processed = await processReconciliationCandidates(sql, env, broadcastEvent);

      expect(processed).toBe(1);
      expect(vi.mocked(cancelAgentSessionOnNode)).toHaveBeenCalledWith(
        'node-1',
        'ws-1',
        'acp-1',
        expect.anything(),
        'user-1',
        { requestTimeoutMs: 2345 }
      );
      expect(vi.mocked(sendPromptToAgentOnNode)).not.toHaveBeenCalled();
      expect(
        db.prepare('SELECT * FROM chat_messages WHERE session_id = ?').all('session-1')
      ).toHaveLength(0);
      expect(
        db
          .prepare(`SELECT * FROM session_attention_markers WHERE kind = 'reconciliation_checkin'`)
          .all()
      ).toHaveLength(0);
      expect(
        db
          .prepare(
            `SELECT * FROM activity_events WHERE event_type = 'reconciliation.prompt_cancel_requested'`
          )
          .all()
      ).toHaveLength(1);
    });

    it('bounds failed cancel attempts and quarantines without manufacturing turn-end', async () => {
      const { cancelAgentSessionOnNode, sendPromptToAgentOnNode } =
        await import('../../../src/services/node-agent');
      vi.mocked(cancelAgentSessionOnNode).mockResolvedValue({ success: false, status: 503 });
      setupTaskSession();
      setSessionActivity({ promptStartedAt: now - TWO_HOURS - 1000 });
      const env = {
        ...envWithRows(
          { 'task-1': { task_mode: 'task', status: 'in_progress' } },
          { 'ws-1': { node_id: 'node-1', user_id: 'user-1' } }
        ),
        TASK_RECONCILIATION_PROMPT_SOFT_STALL_MS: String(THIRTY_MINUTES),
        TASK_RECONCILIATION_PROMPT_HARD_STALL_MS: String(TWO_HOURS),
        TASK_RECONCILIATION_CANDIDATE_LEASE_MS: '1000',
        TASK_RECONCILIATION_PROBE_MAX_ATTEMPTS: '2',
        TASK_RECONCILIATION_QUARANTINE_MS: String(FIVE_MINUTES),
        TASK_LIVENESS_NODE_HEALTH_PROBE_TIMEOUT_MS: '1',
        TASK_LIVENESS_PROBE_TIMEOUT_MS: '1',
        TASK_RECONCILIATION_NODE_CALL_TIMEOUT_MS: '1',
        TASK_RECONCILIATION_MIN_ALARM_DELAY_MS: '1',
      } as ProjectDataEnv;
      const broadcastEvent = vi.fn();

      expect(await processReconciliationCandidates(sql, env, broadcastEvent)).toBe(0);
      vi.setSystemTime(now + 1001);
      expect(await processReconciliationCandidates(sql, env, broadcastEvent)).toBe(0);
      vi.setSystemTime(now + 2002);
      expect(await processReconciliationCandidates(sql, env, broadcastEvent)).toBe(0);

      expect(cancelAgentSessionOnNode).toHaveBeenCalledTimes(2);
      expect(sendPromptToAgentOnNode).not.toHaveBeenCalled();
      expect(broadcastEvent).not.toHaveBeenCalledWith(
        'session.activity',
        expect.objectContaining({ activity: 'idle' }),
        expect.anything()
      );
      expect(
        db.prepare(`SELECT activity FROM session_state WHERE session_id = 'acp-1'`).get()
      ).toEqual({ activity: 'prompting' });
      expect(db.prepare(`SELECT status FROM chat_sessions WHERE id = 'session-1'`).get()).toEqual({
        status: 'active',
      });
      expect(
        db
          .prepare(
            `SELECT COUNT(*) AS count FROM activity_events
             WHERE event_type = 'reconciliation.candidate_quarantined'`
          )
          .get<{ count: number }>()!.count
      ).toBe(1);
      expect(
        db
          .prepare(`SELECT COUNT(*) AS count FROM session_attention_markers`)
          .get<{ count: number }>()!.count
      ).toBe(0);
    });

    it('repairs stale prompting mirror when the VM reports no prompt in flight during hard-stall cancel', async () => {
      const { cancelAgentSessionOnNode, sendPromptToAgentOnNode } =
        await import('../../../src/services/node-agent');
      vi.mocked(cancelAgentSessionOnNode).mockResolvedValueOnce({ success: false, status: 409 });
      setupTaskSession({ lastActivityAt: now - FIVE_MINUTES - 1000 });
      setSessionActivity({ promptStartedAt: now - TWO_HOURS - 1000 });
      const env = {
        ...envWithRows(
          { 'task-1': { task_mode: 'task', status: 'in_progress' } },
          { 'ws-1': { node_id: 'node-1', user_id: 'user-1' } }
        ),
        TASK_RECONCILIATION_PROMPT_SOFT_STALL_MS: String(THIRTY_MINUTES),
        TASK_RECONCILIATION_PROMPT_HARD_STALL_MS: String(TWO_HOURS),
      } as ProjectDataEnv;
      const broadcastEvent = vi.fn();

      const firstPass = await processReconciliationCandidates(sql, env, broadcastEvent);
      expect(firstPass).toBe(1);
      expect(vi.mocked(sendPromptToAgentOnNode)).not.toHaveBeenCalled();
      expect(
        db.prepare(`SELECT activity FROM session_state WHERE session_id = 'acp-1'`).get()
      ).toMatchObject({
        activity: 'idle',
      });

      vi.setSystemTime(now + 35_001);
      const secondPass = await processReconciliationCandidates(sql, env, broadcastEvent);
      expect(secondPass).toBe(1);
      expect(vi.mocked(sendPromptToAgentOnNode)).toHaveBeenCalledWith(
        'node-1',
        'ws-1',
        'acp-1',
        expect.stringContaining('continue working from where you left off'),
        expect.anything(),
        'user-1',
        expect.any(String),
        expect.objectContaining({
          requestTimeoutMs: 5000,
          protocolVersion: 1,
          deliveryId: expect.any(String),
        })
      );
    });
  });

  describe('computeReconciliationAlarmTime', () => {
    it('returns null when no task-mode sessions exist', () => {
      const env = {
        DATABASE: createMockD1(),
      } as unknown as import('../../../src/durable-objects/project-data/types').Env;
      const time = computeReconciliationAlarmTime(sql, env);
      expect(time).toBeNull();
    });

    it('returns earliest activity + idle threshold for eligible sessions', () => {
      setupTaskSession({ lastActivityAt: now - 60000 }); // 1 minute ago
      const env = {
        DATABASE: createMockD1(),
      } as unknown as import('../../../src/durable-objects/project-data/types').Env;

      const time = computeReconciliationAlarmTime(sql, env);
      expect(time).not.toBeNull();
      // Should fire at lastActivityAt + 5 minutes
      expect(time).toBe(now - 60000 + FIVE_MINUTES);
    });

    it('returns earliest activity + idle threshold when idle cleanup schedule is missing', () => {
      setupTaskSession({ lastActivityAt: now - 60000, withIdleCleanup: false });
      const env = {
        DATABASE: createMockD1(),
      } as unknown as import('../../../src/durable-objects/project-data/types').Env;

      const time = computeReconciliationAlarmTime(sql, env);
      expect(time).toBe(now - 60000 + FIVE_MINUTES);
    });

    it('returns at least 10 seconds in the future', () => {
      // Activity was 10 minutes ago — alarm time would be in the past
      setupTaskSession({ lastActivityAt: now - 10 * 60 * 1000 });
      const env = {
        DATABASE: createMockD1(),
      } as unknown as import('../../../src/durable-objects/project-data/types').Env;

      const time = computeReconciliationAlarmTime(sql, env);
      expect(time).not.toBeNull();
      expect(time!).toBeGreaterThanOrEqual(now + 10_000);
    });

    it('uses configurable minimum alarm delay from env', () => {
      setupTaskSession({ lastActivityAt: now - 10 * 60 * 1000 });
      const customDelayMs = 30_000;
      const env = {
        DATABASE: createMockD1(),
        TASK_RECONCILIATION_MIN_ALARM_DELAY_MS: String(customDelayMs),
      } as unknown as import('../../../src/durable-objects/project-data/types').Env;

      const time = computeReconciliationAlarmTime(sql, env);

      expect(time).toBe(now + customDelayMs);
    });

    it('does not re-arm before a durable candidate lease or quarantine expires', async () => {
      setupTaskSession({ lastActivityAt: now - 10 * 60 * 1000 });
      const leaseMs = 45_000;
      const env = {
        ...envWithRows({ 'task-1': { task_mode: 'task', status: 'in_progress' } }),
        TASK_RECONCILIATION_CANDIDATE_LEASE_MS: String(leaseMs),
      } as ProjectDataEnv;

      expect(await getReconciliationCandidates(sql, env)).toHaveLength(1);
      expect(computeReconciliationAlarmTime(sql, env)).toBe(now + leaseMs);
    });

    it('excludes sessions with active markers from alarm calculation', () => {
      setupTaskSession();
      createAttentionMarker(sql, {
        sessionId: 'session-1',
        taskId: 'task-1',
        workspaceId: 'ws-1',
        kind: 'reconciliation_checkin',
        source: 'sam_orchestrator',
        expiresAt: now + ONE_MINUTE,
      });
      const env = {
        DATABASE: createMockD1(),
      } as unknown as import('../../../src/durable-objects/project-data/types').Env;

      const time = computeReconciliationAlarmTime(sql, env);
      expect(time).toBeNull();
    });

    it('uses configurable idle threshold from env', () => {
      setupTaskSession({ lastActivityAt: now - 60000 }); // 1 minute ago
      const customIdleMs = 10 * 60 * 1000; // 10 minutes
      const env = {
        DATABASE: createMockD1(),
        TASK_RECONCILIATION_IDLE_MS: String(customIdleMs),
      } as unknown as import('../../../src/durable-objects/project-data/types').Env;

      const time = computeReconciliationAlarmTime(sql, env);
      expect(time).toBe(now - 60000 + customIdleMs);
    });

    it('schedules prompt-in-flight sessions at the soft threshold first', () => {
      setupTaskSession({ lastActivityAt: now - 10 * 60 * 1000 });
      setSessionActivity({ promptStartedAt: now - 10 * 60 * 1000 });
      const env = {
        DATABASE: createMockD1(),
        TASK_RECONCILIATION_PROMPT_SOFT_STALL_MS: String(THIRTY_MINUTES),
        TASK_RECONCILIATION_PROMPT_HARD_STALL_MS: String(TWO_HOURS),
      } as unknown as ProjectDataEnv;

      const time = computeReconciliationAlarmTime(sql, env);

      expect(time).toBe(now - 10 * 60 * 1000 + THIRTY_MINUTES);
    });

    it('schedules observed prompt-in-flight sessions at the hard threshold', () => {
      setupTaskSession({ lastActivityAt: now - 40 * 60 * 1000 });
      setSessionActivity({ promptStartedAt: now - 40 * 60 * 1000 });
      const env = {
        DATABASE: createMockD1(),
        TASK_RECONCILIATION_PROMPT_SOFT_STALL_MS: String(THIRTY_MINUTES),
        TASK_RECONCILIATION_PROMPT_HARD_STALL_MS: String(TWO_HOURS),
      } as unknown as ProjectDataEnv;

      const time = computeReconciliationAlarmTime(sql, env);

      expect(time).toBe(now - 40 * 60 * 1000 + TWO_HOURS);
    });
  });

  describe('computeProjectDataAlarmTime', () => {
    it('keeps reconciliation deadline ahead of healthy heartbeat timeout', () => {
      setupTaskSession({ lastActivityAt: now - 60000 }); // reconciliation due in 4 minutes
      setAcpHeartbeat('acp-1', now); // heartbeat timeout due in 5 minutes by default
      const env = { DATABASE: createMockD1() } as unknown as ProjectDataEnv;

      const time = computeProjectDataAlarmTime(sql, env);

      expect(time).toBe(now - 60000 + FIVE_MINUTES);
    });

    it('keeps workspace idle check ahead of healthy heartbeat timeout', () => {
      db.prepare(
        `INSERT INTO chat_sessions (id, workspace_id, task_id, topic, status, message_count, started_at, created_at, updated_at)
         VALUES ('session-workspace', 'ws-workspace', NULL, 'Workspace', 'active', 0, ?, ?, ?)`
      ).run(now - 600000, now - 600000, now - 600000);
      db.prepare(
        `INSERT INTO workspace_activity (workspace_id, session_id, last_message_at, last_terminal_activity_at, created_at)
         VALUES ('ws-workspace', 'session-workspace', ?, 0, ?)`
      ).run(now - 4 * 60 * 1000, now - 4 * 60 * 1000);
      db.prepare(
        `INSERT INTO acp_sessions (id, chat_session_id, status, agent_type, workspace_id, node_id, last_heartbeat_at, created_at, updated_at)
         VALUES ('acp-workspace', 'session-workspace', 'running', 'claude_code', 'ws-workspace', 'node-1', ?, ?, ?)`
      ).run(now, now - 600000, now - 600000);
      const env = { DATABASE: createMockD1() } as unknown as ProjectDataEnv;

      const time = computeProjectDataAlarmTime(sql, env);

      expect(time).toBe(now + 60_000);
    });
  });

  describe('Attention marker resolution on agent response', () => {
    it('agent message resolves reconciliation_checkin marker', () => {
      setupTaskSession();
      createAttentionMarker(sql, {
        sessionId: 'session-1',
        taskId: 'task-1',
        workspaceId: 'ws-1',
        kind: 'reconciliation_checkin',
        source: 'sam_orchestrator',
        expiresAt: now + ONE_MINUTE,
      });

      // Simulate: resolveAttentionMarkers is called when persistMessage role='user'
      // But actually, agent responses are role='assistant' — they reset idle cleanup
      // but don't resolve attention markers directly. The marker gets resolved when
      // complete_task or request_human_input is called (which creates a new marker or
      // completes the task), OR when a human message arrives.
      //
      // However, any activity (message persist) resets the idle cleanup timer,
      // which means the reconciliation won't fire again (no re-candidate).
      // The marker's 1-minute deadline is the safety net.

      // Verify marker exists
      const before = db
        .prepare(
          `SELECT * FROM session_attention_markers WHERE session_id = ? AND resolved_at IS NULL`
        )
        .all('session-1');
      expect(before).toHaveLength(1);

      // Simulate agent message resolving markers
      const resolved = resolveAttentionMarkers(sql, 'session-1', 'msg-1', 'human', 'human_message');
      expect(resolved).toBe(1);

      const after = db
        .prepare(
          `SELECT * FROM session_attention_markers WHERE session_id = ? AND resolved_at IS NULL`
        )
        .all('session-1');
      expect(after).toHaveLength(0);
    });
  });

  describe('Expired marker handling (expiry path)', () => {
    it('getExpiredMarkers returns reconciliation_checkin markers past their deadline', () => {
      setupTaskSession();
      // Create a reconciliation_checkin marker that has already expired
      createAttentionMarker(sql, {
        sessionId: 'session-1',
        taskId: 'task-1',
        workspaceId: 'ws-1',
        kind: 'reconciliation_checkin',
        source: 'sam_orchestrator',
        expiresAt: now - 1000, // expired 1 second ago
      });

      const expired = getExpiredMarkers(sql, now);
      expect(expired).toHaveLength(1);
      expect(expired[0].kind).toBe('reconciliation_checkin');
      expect(expired[0].taskId).toBe('task-1');
      expect(expired[0].workspaceId).toBe('ws-1');
      expect(expired[0].sessionId).toBe('session-1');
    });

    it('resolveAttentionMarkerById resolves expired reconciliation_checkin marker', () => {
      setupTaskSession();
      const marker = createAttentionMarker(sql, {
        sessionId: 'session-1',
        taskId: 'task-1',
        workspaceId: 'ws-1',
        kind: 'reconciliation_checkin',
        source: 'sam_orchestrator',
        expiresAt: now - 1000,
      });

      const resolved = resolveAttentionMarkerById(sql, marker.id, 'system', 'expired');
      expect(resolved).toBe(1);

      // Verify marker is now resolved
      const rows = db
        .prepare(
          `SELECT resolved_at, resolved_by_actor_type, resolved_reason
         FROM session_attention_markers WHERE id = ?`
        )
        .all(marker.id);
      expect(rows).toHaveLength(1);
      expect((rows[0] as Record<string, unknown>).resolved_at).toBeTruthy();
      expect((rows[0] as Record<string, unknown>).resolved_by_actor_type).toBe('system');
      expect((rows[0] as Record<string, unknown>).resolved_reason).toBe('expired');
    });

    it('non-expired reconciliation_checkin marker is not returned by getExpiredMarkers', () => {
      setupTaskSession();
      createAttentionMarker(sql, {
        sessionId: 'session-1',
        taskId: 'task-1',
        workspaceId: 'ws-1',
        kind: 'reconciliation_checkin',
        source: 'sam_orchestrator',
        expiresAt: now + ONE_MINUTE, // not yet expired
      });

      const expired = getExpiredMarkers(sql, now);
      expect(expired).toHaveLength(0);
    });
  });

  describe('Additional exclusion cases', () => {
    it('excludes cancelled tasks', async () => {
      setupTaskSession();
      const mockDb = createMockD1({
        'task-1': { task_mode: 'task', status: 'cancelled' },
      });
      const env = {
        DATABASE: mockDb,
      } as unknown as import('../../../src/durable-objects/project-data/types').Env;

      const candidates = await getReconciliationCandidates(sql, env);
      expect(candidates).toHaveLength(0);
    });
  });
});
