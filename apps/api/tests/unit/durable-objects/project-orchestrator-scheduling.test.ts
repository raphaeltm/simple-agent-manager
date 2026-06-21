/**
 * Capability tests for ProjectOrchestrator scheduling cycle.
 *
 * Tests the cross-boundary behavior:
 * - Task completes → orchestrator notified → handoff routed → dependent auto-dispatched
 * - Non-mission tasks are unaffected
 * - Concurrency limits respected
 * - Stall detection sends interrupts
 */
import { resolveOrchestratorConfig } from '@simple-agent-manager/shared';
import { describe, expect, it, vi } from 'vitest';

import { runSchedulingCycle } from '../../../src/durable-objects/project-orchestrator/scheduling';

// ── Mock helpers ──────────────────────────────────────────────────────────────

function makeSqlStorage(tables: Record<string, unknown[]> = {}) {
  const data: Record<string, unknown[]> = { ...tables };
  return {
    exec: vi.fn((query: string, ...params: unknown[]) => {
      const q = query.trim().toUpperCase();

      // Handle INSERT
      if (q.startsWith('INSERT')) {
        const tableMatch = query.match(/INSERT INTO (\w+)/i);
        const tableName = tableMatch?.[1] ?? 'unknown';
        if (!data[tableName]) data[tableName] = [];
        data[tableName].push({ query, params });
        return { rowsWritten: 1, toArray: () => [] };
      }

      // Handle UPDATE
      if (q.startsWith('UPDATE')) {
        return { rowsWritten: 1, toArray: () => [] };
      }

      // Handle DELETE
      if (q.startsWith('DELETE')) {
        return { rowsWritten: 0, toArray: () => [] };
      }

      // Handle SELECT on orchestrator_missions
      if (q.includes('ORCHESTRATOR_MISSIONS') && q.includes('SELECT')) {
        return {
          toArray: () => data['orchestrator_missions'] ?? [],
        };
      }

      // Handle SELECT on decision_log (handoff idempotency check)
      if (q.includes('DECISION_LOG') && q.includes('SELECT')) {
        return { toArray: () => [] };
      }

      return { toArray: () => [], rowsWritten: 0 };
    }),
    _data: data,
  } as unknown as SqlStorage;
}

interface MockD1Result {
  results: unknown[];
}

interface MockTaskRow extends Record<string, unknown> {
  id: string;
  status: string;
  scheduler_state: string | null;
  mission_id: string;
  updated_at: string;
}

interface MockDependencyRow {
  task_id: string;
  depends_on_task_id: string;
}

interface MockSessionRow {
  id: string;
  taskId: string;
  status: string;
}

interface MockProjectDataMessage {
  targetSessionId: string;
  sourceTaskId: string | null;
  senderType: string;
  senderId: string | null;
  messageClass: string;
  content: string;
  metadata?: Record<string, unknown> | null;
}

function makeMockEnv(overrides: {
  tasks?: MockTaskRow[];
  dependencies?: MockDependencyRow[];
  handoffs?: unknown[];
  sessions?: MockSessionRow[];
  mission?: { budget_config: string | null };
  project?: Record<string, unknown>;
  user?: Record<string, unknown>;
} = {}) {
  const {
    tasks = [],
    dependencies = [],
    handoffs = [],
    sessions = [],
    mission = { budget_config: null },
    project = null,
    user = null,
  } = overrides;

  const startTaskRunnerCalls: unknown[] = [];
  const mailboxMessages: MockProjectDataMessage[] = [];
  const sessionsCreated: string[] = [];
  const messagesPersisted: unknown[] = [];
  const generatedSessions = new Map<string, MockSessionRow>();

  const projectDataStub = {
    ensureProjectId: vi.fn(),
    createSession: vi.fn(async (_workspaceId: string | null, _topic: string | null, taskId: string | null) => {
      const id = `session-${sessionsCreated.length}`;
      sessionsCreated.push(id);
      if (taskId) {
        generatedSessions.set(taskId, { id, taskId, status: 'active' });
      }
      return id;
    }),
    persistMessage: vi.fn(async (...args: unknown[]) => {
      messagesPersisted.push(args);
      return 'message-1';
    }),
    getHandoffPacketsForTask: vi.fn(async () => handoffs),
    getSessionsByTaskIds: vi.fn(async (taskIds: string[]) => {
      const allSessions = [...sessions, ...generatedSessions.values()];
      return allSessions.filter((session) => taskIds.includes(session.taskId));
    }),
    enqueueMailboxMessage: vi.fn(async (message: MockProjectDataMessage) => {
      mailboxMessages.push(message);
      return {
        id: `mailbox-${mailboxMessages.length}`,
        ...message,
        deliveryState: 'queued',
      };
    }),
  };

  const taskRunnerStub = {
    start: vi.fn(async (input: unknown) => {
      startTaskRunnerCalls.push(input);
    }),
  };

  const env = {
    DATABASE: {
      prepare: vi.fn((query: string) => ({
        bind: vi.fn((...args: unknown[]) => ({
          all: vi.fn(async (): Promise<MockD1Result> => {
            const q = query.trim().toUpperCase();
            // Dependencies
            if (q.includes('TASK_DEPENDENCIES')) {
              if (q.includes('DEPENDS_ON_TASK_ID = ?')) {
                const dependsOnTaskId = args[0];
                return {
                  results: dependencies
                    .filter((dep) => dep.depends_on_task_id === dependsOnTaskId)
                    .map((dep) => ({ task_id: dep.task_id })),
                };
              }
              return { results: dependencies };
            }
            // Schedulable tasks for auto-dispatch
            if (q.includes('SCHEDULER_STATE') && q.includes('SCHEDULABLE')) {
              return {
                results: tasks.filter((task) =>
                  task.scheduler_state === 'schedulable' && task.status === 'queued',
                ),
              };
            }
            // Tasks for mission
            if (q.includes('FROM TASKS') && q.includes('MISSION_ID')) {
              return { results: tasks };
            }
            return { results: [] };
          }),
          first: vi.fn(async () => {
            const q = query.trim().toUpperCase();
            // Active count
            if (q.includes('COUNT(*)')) {
              const active = tasks.filter((task) =>
                ['in_progress', 'delegated', 'provisioning', 'running'].includes(task.status),
              );
              return { cnt: active.length };
            }
            // Mission budget_config
            if (q.includes('BUDGET_CONFIG')) {
              return mission;
            }
            // Project info
            if (q.includes('FROM PROJECTS')) {
              return project ?? {
                repository: 'org/repo',
                installation_id: 'inst-1',
                default_branch: 'main',
                default_vm_size: null,
                default_provider: null,
                default_location: null,
                default_agent_type: null,
                default_workspace_profile: null,
                default_devcontainer_config_name: null,
                task_execution_timeout_ms: null,
                max_workspaces_per_node: null,
                node_cpu_threshold_percent: null,
                node_memory_threshold_percent: null,
                warm_node_timeout_ms: null,
              };
            }
            // User info
            if (q.includes('FROM USERS')) {
              return user ?? { name: 'Test User', email: 'test@example.com', github_id: '12345' };
            }
            return null;
          }),
          run: vi.fn(async () => ({ meta: { changes: 1 } })),
        })),
      })),
    },
    // Mock PROJECT_DATA for handoff and session operations
    PROJECT_DATA: {
      idFromName: vi.fn(() => 'do-id'),
      get: vi.fn(() => projectDataStub),
    },
    // Mock TASK_RUNNER for auto-dispatch
    TASK_RUNNER: {
      idFromName: vi.fn(() => 'task-runner-id'),
      get: vi.fn(() => taskRunnerStub),
    },
  };

  return {
    env: env as unknown as import('../../../src/env').Env,
    startTaskRunnerCalls,
    mailboxMessages,
    sessionsCreated,
    messagesPersisted,
    projectDataStub,
    taskRunnerStub,
  };
}

function makeTask(overrides: Partial<MockTaskRow> & { id: string }): MockTaskRow {
  return {
    status: 'queued',
    scheduler_state: 'pending',
    mission_id: 'mission-1',
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

function getDecisionInserts(sql: SqlStorage) {
  return (sql.exec as ReturnType<typeof vi.fn>).mock.calls.filter(
    (call: unknown[]) => typeof call[0] === 'string' && (call[0] as string).includes('INSERT INTO decision_log'),
  );
}

// ── Tests ──────────────────────────────────────────────────────────────────────

const defaultConfig = resolveOrchestratorConfig({});

describe('Scheduling Cycle — Auto-Dispatch', () => {
  const config = defaultConfig;

  it('dispatches schedulable tasks via startTaskRunnerDO', async () => {
    const sql = makeSqlStorage({
      orchestrator_missions: [{ mission_id: 'mission-1' }],
    });

    const { env, startTaskRunnerCalls, messagesPersisted, sessionsCreated } = makeMockEnv({
      tasks: [
        makeTask({
          id: 'task-1',
          status: 'queued',
          scheduler_state: 'schedulable',
          title: 'Test Task',
          description: 'Do something',
          user_id: 'user-1',
          project_id: 'proj-1',
          output_branch: 'sam/test',
          dispatch_depth: 0,
          priority: 0,
        }),
      ],
    });

    await runSchedulingCycle(sql, env, 'proj-1', config);

    expect(sessionsCreated).toEqual(['session-0']);
    expect(messagesPersisted).toContainEqual([
      'session-0',
      'user',
      'Do something',
      null,
      undefined,
    ]);
    expect(startTaskRunnerCalls).toHaveLength(1);
    expect(startTaskRunnerCalls[0]).toMatchObject({
      taskId: 'task-1',
      projectId: 'proj-1',
      userId: 'user-1',
      config: {
        chatSessionId: 'session-0',
        taskDescription: 'Do something',
      },
    });

    // Verify the scheduling cycle updated orchestrator_missions
    const updateCalls = (sql.exec as ReturnType<typeof vi.fn>).mock.calls.filter(
      (call: unknown[]) => typeof call[0] === 'string' && (call[0] as string).includes('UPDATE orchestrator_missions'),
    );
    expect(updateCalls.length).toBeGreaterThan(0);
  });

  it('skips scheduling when no active missions exist', async () => {
    const sql = makeSqlStorage({
      orchestrator_missions: [],
    });
    const { env } = makeMockEnv();

    await runSchedulingCycle(sql, env, 'proj-1', config);

    // Should not have made any D1 calls (no missions to process)
    expect(env.DATABASE.prepare).not.toHaveBeenCalled();
  });

  it('logs decisions for concurrency limit hits', async () => {
    const sql = makeSqlStorage({
      orchestrator_missions: [{ mission_id: 'mission-1' }],
    });

    // 5 running tasks = at concurrency limit (default maxActiveTasksPerMission = 5)
    const tasks = [
      ...Array.from({ length: 5 }, (_, i) => makeTask({
        id: `running-${i}`, status: 'running', scheduler_state: 'running',
      })),
      makeTask({
        id: 'queued-1', status: 'queued', scheduler_state: 'schedulable',
        title: 'Blocked', description: null, user_id: 'user-1', project_id: 'proj-1',
        output_branch: null, dispatch_depth: 0, priority: 0,
      }),
    ];

    const { env } = makeMockEnv({ tasks });

    await runSchedulingCycle(sql, env, 'proj-1', config);

    // Should have logged a skip decision for concurrency limit
    const insertCalls = getDecisionInserts(sql);
    const skipDecision = insertCalls.find(
      (call: unknown[]) => (call as string[]).some(arg => typeof arg === 'string' && arg.includes('concurrency limit')),
    );
    expect(skipDecision).toBeDefined();
  });
});

describe('Scheduling Cycle — Stall Detection', () => {
  it('enqueues stalled task interrupt to the task chat session id', async () => {
    const stallConfig = resolveOrchestratorConfig({
      ORCHESTRATOR_STALL_TIMEOUT_MS: '1000', // 1 second for test
    });

    const sql = makeSqlStorage({
      orchestrator_missions: [{ mission_id: 'mission-1' }],
    });

    const stalledTime = new Date(Date.now() - 5000).toISOString(); // 5s ago

    const { env, mailboxMessages } = makeMockEnv({
      tasks: [
        makeTask({
          id: 'stalled-task', status: 'running', scheduler_state: 'running',
          updated_at: stalledTime,
        }),
      ],
      sessions: [
        { id: 'session-stalled-task', taskId: 'stalled-task', status: 'active' },
      ],
    });

    await runSchedulingCycle(sql, env, 'proj-1', stallConfig);

    expect(mailboxMessages).toHaveLength(1);
    expect(mailboxMessages[0]).toMatchObject({
      targetSessionId: 'session-stalled-task',
      sourceTaskId: null,
      senderType: 'orchestrator',
      messageClass: 'interrupt',
      metadata: {
        reason: 'stall_detection',
      },
    });
    expect(mailboxMessages[0]?.targetSessionId).not.toBe('stalled-task');

    const stallDecision = getDecisionInserts(sql).find((call: unknown[]) =>
      call.includes('stall_detected'),
    );
    expect(stallDecision).toBeDefined();
    expect(stallDecision).toContain('Task stalled for 0min — interrupt sent');
  });

  it('logs and skips stalled task interrupt when no active session exists', async () => {
    const stallConfig = resolveOrchestratorConfig({
      ORCHESTRATOR_STALL_TIMEOUT_MS: '1000',
    });
    const sql = makeSqlStorage({
      orchestrator_missions: [{ mission_id: 'mission-1' }],
    });
    const stalledTime = new Date(Date.now() - 5000).toISOString();
    const { env, mailboxMessages } = makeMockEnv({
      tasks: [
        makeTask({
          id: 'stalled-task',
          status: 'running',
          scheduler_state: 'running',
          updated_at: stalledTime,
        }),
      ],
    });

    await runSchedulingCycle(sql, env, 'proj-1', stallConfig);

    expect(mailboxMessages).toHaveLength(0);
    const missingSessionDecision = getDecisionInserts(sql).find((call: unknown[]) =>
      call.includes('No active chat session found for stalled task; interrupt not enqueued'),
    );
    expect(missingSessionDecision).toBeDefined();
  });
});

describe('Scheduling Cycle — Handoff Routing', () => {
  const config = defaultConfig;

  it('enqueues handoff deliver message to the dependent task chat session id', async () => {
    const sql = makeSqlStorage({
      orchestrator_missions: [{ mission_id: 'mission-1' }],
    });
    const { env, mailboxMessages } = makeMockEnv({
      tasks: [
        makeTask({
          id: 'source-task',
          status: 'completed',
          scheduler_state: 'completed',
        }),
        makeTask({
          id: 'dependent-task',
          status: 'queued',
          scheduler_state: 'blocked',
        }),
      ],
      dependencies: [
        { task_id: 'dependent-task', depends_on_task_id: 'source-task' },
      ],
      sessions: [
        { id: 'session-dependent-task', taskId: 'dependent-task', status: 'active' },
      ],
      handoffs: [
        {
          id: 'handoff-1',
          missionId: 'mission-1',
          fromTaskId: 'source-task',
          toTaskId: 'dependent-task',
          summary: 'Use the fixed mailbox route.',
          facts: [{ key: 'target', value: 'chat session' }],
          openQuestions: ['Does the dependent agent see the handoff?'],
          artifactRefs: [],
          suggestedActions: ['Continue from source-task findings'],
          version: 1,
          createdAt: Date.now(),
        },
      ],
    });

    await runSchedulingCycle(sql, env, 'proj-1', config);

    expect(mailboxMessages).toHaveLength(1);
    expect(mailboxMessages[0]).toMatchObject({
      targetSessionId: 'session-dependent-task',
      sourceTaskId: 'source-task',
      senderType: 'orchestrator',
      messageClass: 'deliver',
      metadata: {
        handoffId: 'handoff-1',
        fromTaskId: 'source-task',
      },
    });
    expect(mailboxMessages[0]?.targetSessionId).not.toBe('dependent-task');
    expect(mailboxMessages[0]?.content).toContain('**Summary:** Use the fixed mailbox route.');
    expect(mailboxMessages[0]?.content).toContain('- target: chat session');
  });

  it('logs and skips handoff routing when dependent task has no active session', async () => {
    const sql = makeSqlStorage({
      orchestrator_missions: [{ mission_id: 'mission-1' }],
    });
    const { env, mailboxMessages } = makeMockEnv({
      tasks: [
        makeTask({
          id: 'source-task',
          status: 'completed',
          scheduler_state: 'completed',
        }),
        makeTask({
          id: 'dependent-task',
          status: 'queued',
          scheduler_state: 'blocked',
        }),
      ],
      dependencies: [
        { task_id: 'dependent-task', depends_on_task_id: 'source-task' },
      ],
      handoffs: [
        {
          id: 'handoff-1',
          summary: 'No session yet.',
          facts: [],
          openQuestions: [],
          suggestedActions: [],
        },
      ],
    });

    await runSchedulingCycle(sql, env, 'proj-1', config);

    expect(mailboxMessages).toHaveLength(0);
    const missingSessionDecision = getDecisionInserts(sql).find((call: unknown[]) =>
      call.includes('No active chat session found for dependent task; handoff not enqueued'),
    );
    expect(missingSessionDecision).toBeDefined();
    const completedTaskRoutedDecision = getDecisionInserts(sql).find((call: unknown[]) =>
      call.includes('source-task') && call.includes('handoff_routed'),
    );
    expect(completedTaskRoutedDecision).toBeUndefined();
    const retryDecision = getDecisionInserts(sql).find((call: unknown[]) =>
      call.includes('source-task') && call.includes('Handoff routing deferred: one or more dependent task sessions were unavailable'),
    );
    expect(retryDecision).toBeDefined();
  });
});

describe('Scheduling Cycle — Mission Completion', () => {
  const config = defaultConfig;

  it('marks mission as completed when all tasks are terminal', async () => {
    const sql = makeSqlStorage({
      orchestrator_missions: [{ mission_id: 'mission-1' }],
    });

    const { env } = makeMockEnv({
      tasks: [
        { id: 'task-1', status: 'completed', scheduler_state: 'completed', mission_id: 'mission-1', updated_at: new Date().toISOString() },
        { id: 'task-2', status: 'completed', scheduler_state: 'completed', mission_id: 'mission-1', updated_at: new Date().toISOString() },
      ],
    });

    await runSchedulingCycle(sql, env, 'proj-1', config);

    // Should have updated mission status in D1
    const d1Calls = (env.DATABASE.prepare as ReturnType<typeof vi.fn>).mock.calls;
    const missionUpdate = d1Calls.find(
      (call: unknown[]) => typeof call[0] === 'string' && (call[0] as string).includes('UPDATE missions SET status'),
    );
    expect(missionUpdate).toBeDefined();

    // Should have logged a completion decision
    const insertCalls = (sql.exec as ReturnType<typeof vi.fn>).mock.calls.filter(
      (call: unknown[]) => typeof call[0] === 'string' && (call[0] as string).includes('INSERT INTO decision_log'),
    );
    const completionDecision = insertCalls.find(
      (call: unknown[]) => (call as string[]).some(arg => typeof arg === 'string' && arg.includes('Mission completed')),
    );
    expect(completionDecision).toBeDefined();
  });

  it('marks mission as failed when any task failed', async () => {
    const sql = makeSqlStorage({
      orchestrator_missions: [{ mission_id: 'mission-1' }],
    });

    const { env } = makeMockEnv({
      tasks: [
        { id: 'task-1', status: 'completed', scheduler_state: 'completed', mission_id: 'mission-1', updated_at: new Date().toISOString() },
        { id: 'task-2', status: 'failed', scheduler_state: 'failed', mission_id: 'mission-1', updated_at: new Date().toISOString() },
      ],
    });

    await runSchedulingCycle(sql, env, 'proj-1', config);

    // Should have logged a failed mission decision
    const insertCalls = (sql.exec as ReturnType<typeof vi.fn>).mock.calls.filter(
      (call: unknown[]) => typeof call[0] === 'string' && (call[0] as string).includes('INSERT INTO decision_log'),
    );
    const failDecision = insertCalls.find(
      (call: unknown[]) => (call as string[]).some(arg => typeof arg === 'string' && arg.includes('Mission failed')),
    );
    expect(failDecision).toBeDefined();
  });
});
