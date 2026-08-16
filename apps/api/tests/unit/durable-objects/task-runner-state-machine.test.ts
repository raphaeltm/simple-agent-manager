import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  failTask,
  transitionToInProgress,
} from '../../../src/durable-objects/task-runner/state-machine';
import type {
  TaskRunnerContext,
  TaskRunnerState,
} from '../../../src/durable-objects/task-runner/types';

const {
  cleanupTaskRunMock,
  deleteNodeResourcesStrictMock,
  failSessionSnapshotRecoveryMock,
  failSessionMock,
  notifyTaskEventMock,
  persistErrorMock,
  persistMessageMock,
  revokeMcpTokenMock,
  restoreSessionRecoveryHandoffMock,
  sleepSessionMock,
  stopComputeTrackingMock,
  stopWorkspaceOnNodeMock,
  syncTriggerExecutionStatusMock,
} = vi.hoisted(() => ({
  cleanupTaskRunMock: vi.fn(async () => undefined),
  deleteNodeResourcesStrictMock: vi.fn(async () => undefined),
  failSessionSnapshotRecoveryMock: vi.fn(async () => undefined),
  failSessionMock: vi.fn(async () => undefined),
  notifyTaskEventMock: vi.fn(async () => undefined),
  persistErrorMock: vi.fn(async () => undefined),
  persistMessageMock: vi.fn(async () => undefined),
  revokeMcpTokenMock: vi.fn(async () => undefined),
  restoreSessionRecoveryHandoffMock: vi.fn(async () => undefined),
  sleepSessionMock: vi.fn(async () => true),
  stopComputeTrackingMock: vi.fn(async () => undefined),
  stopWorkspaceOnNodeMock: vi.fn(async () => undefined),
  syncTriggerExecutionStatusMock: vi.fn(async () => undefined),
}));

vi.mock('../../../src/lib/ulid', () => ({
  ulid: () => 'event-id',
}));

vi.mock('../../../src/services/trigger-execution-sync', () => ({
  syncTriggerExecutionStatus: syncTriggerExecutionStatusMock,
}));

vi.mock('../../../src/services/observability', async () => {
  const actual = await vi.importActual<typeof import('../../../src/services/observability')>(
    '../../../src/services/observability'
  );
  return { ...actual, persistError: persistErrorMock };
});

vi.mock('../../../src/services/project-data', () => ({
  failSession: failSessionMock,
  persistMessage: persistMessageMock,
  reconcileTaskWaits: vi.fn(async () => undefined),
  sleepSession: sleepSessionMock,
}));

vi.mock('../../../src/services/session-snapshots', () => ({
  failSessionSnapshotRecovery: failSessionSnapshotRecoveryMock,
}));

vi.mock('../../../src/services/session-recovery-authority', () => ({
  restoreSessionRecoveryHandoff: restoreSessionRecoveryHandoffMock,
}));

vi.mock('../../../src/services/project-orchestrator', () => ({
  notifyTaskEvent: notifyTaskEventMock,
}));

vi.mock('../../../src/services/mcp-token', () => ({
  revokeMcpToken: revokeMcpTokenMock,
}));

vi.mock('../../../src/services/node-agent', () => ({
  stopWorkspaceOnNode: stopWorkspaceOnNodeMock,
}));

vi.mock('../../../src/services/nodes', () => ({
  deleteNodeResourcesStrict: deleteNodeResourcesStrictMock,
}));

vi.mock('../../../src/services/task-runner', () => ({
  cleanupTaskRun: cleanupTaskRunMock,
}));

vi.mock('../../../src/services/compute-usage', () => ({
  stopComputeTracking: stopComputeTrackingMock,
}));

vi.mock('drizzle-orm/d1', () => ({
  drizzle: () => ({}),
}));

type TaskRow = {
  id: string;
  status: string;
  execution_step: string | null;
  error_message: string | null;
  completed_at: string | null;
  started_at: string | null;
  mission_id: string | null;
  parent_task_id: string | null;
};

type WorkspaceRow = {
  id: string;
  status: string;
};

type TaskStatusEventRow = {
  task_id: string;
  from_status: string | null;
  to_status: string;
  reason: string | null;
};

function createD1State() {
  return {
    tasks: new Map<string, TaskRow>(),
    workspaces: new Map<string, WorkspaceRow>(),
    statusEvents: [] as TaskStatusEventRow[],
  };
}

function createD1Database(
  state: ReturnType<typeof createD1State>,
  options: { onFailureStatusRead?: (task: TaskRow) => void } = {}
) {
  return {
    prepare: vi.fn((sql: string) => ({
      bind: (...params: unknown[]) => ({
        first: async () => {
          if (sql.includes('SELECT status FROM tasks WHERE id = ?')) {
            const task = state.tasks.get(String(params[0]));
            return task ? { status: task.status } : null;
          }
          if (sql.includes('SELECT status, mission_id, parent_task_id FROM tasks WHERE id = ?')) {
            const task = state.tasks.get(String(params[0]));
            const result = task
              ? {
                  status: task.status,
                  mission_id: task.mission_id,
                  parent_task_id: task.parent_task_id,
                }
              : null;
            if (task) options.onFailureStatusRead?.(task);
            return result;
          }
          return null;
        },
        run: async () => {
          if (sql.includes("SET status = 'in_progress'")) {
            const taskId = String(params[2]);
            const task = state.tasks.get(taskId);
            if (!task || task.status !== 'delegated') {
              return { success: true, meta: { changes: 0 } };
            }
            task.status = 'in_progress';
            task.started_at = String(params[0]);
            task.execution_step = 'running';
            return { success: true, meta: { changes: 1 } };
          }

          if (sql.includes("UPDATE tasks SET status = 'failed'")) {
            const taskId = String(params[3]);
            const task = state.tasks.get(taskId);
            if (!task || ['completed', 'failed', 'cancelled'].includes(task.status)) {
              return { success: true, meta: { changes: 0 } };
            }
            task.status = 'failed';
            task.execution_step = null;
            task.error_message = String(params[0]);
            task.completed_at = String(params[1]);
            return { success: true, meta: { changes: 1 } };
          }

          if (sql.includes('INSERT INTO task_status_events')) {
            const isInProgressEvent = sql.includes("'in_progress'");
            state.statusEvents.push({
              task_id: String(params[1]),
              from_status: isInProgressEvent ? 'delegated' : String(params[2]),
              to_status: isInProgressEvent ? 'in_progress' : 'failed',
              reason: String(isInProgressEvent ? params[2] : params[3]),
            });
            return { success: true, meta: { changes: 1 } };
          }

          if (sql.includes("UPDATE workspaces SET status = 'stopped'")) {
            const workspaceId = String(params[1]);
            const workspace = state.workspaces.get(workspaceId);
            if (!workspace) return { success: true, meta: { changes: 0 } };
            workspace.status = 'stopped';
            return { success: true, meta: { changes: 1 } };
          }

          return { success: true, meta: { changes: 1 } };
        },
      }),
    })),
  };
}

function makeState(overrides: Partial<TaskRunnerState> = {}): TaskRunnerState {
  return {
    version: 1,
    taskId: 'task-1',
    projectId: 'project-1',
    userId: 'user-1',
    currentStep: 'agent_session',
    stepResults: {
      nodeId: 'node-1',
      autoProvisioned: false,
      workspaceId: 'workspace-1',
      chatSessionId: null,
      agentSessionId: 'agent-session-1',
      agentStarted: true,
      mcpToken: null,
      provisionedVmSize: null,
    },
    config: {
      vmSize: 'medium',
      vmLocation: 'nbg1',
      branch: 'main',
      preferredNodeId: null,
      userName: null,
      userEmail: null,
      githubId: null,
      taskTitle: 'TaskRunner test',
      taskDescription: null,
      repository: 'octo/repo',
      installationId: 'install-1',
      outputBranch: null,
      defaultBranch: 'main',
      projectDefaultVmSize: null,
      chatSessionId: null,
      agentType: 'openai-codex',
      workspaceProfile: null,
      devcontainerConfigName: null,
      cloudProvider: null,
      taskMode: 'task',
      model: null,
      effort: null,
      permissionMode: null,
      opencodeProvider: null,
      opencodeBaseUrl: null,
      systemPromptAppend: null,
      agentProfileHint: null,
      attachments: null,
    },
    retryCount: 0,
    workspaceReadyReceived: true,
    workspaceReadyStatus: 'running',
    workspaceErrorMessage: null,
    createdAt: Date.parse('2026-06-29T10:00:00.000Z'),
    lastStepAt: Date.parse('2026-06-29T10:00:00.000Z'),
    provisioningStartedAt: null,
    agentReadyStartedAt: null,
    workspaceReadyStartedAt: null,
    workspaceDispatchStartedAt: null,
    workspaceDispatchAttempts: 0,
    workspaceDispatchLastAttemptAt: null,
    workspaceDispatchLastError: null,
    workspaceDispatchAckedAt: null,
    lastD1Step: 'agent_session',
    completed: false,
    ...overrides,
  };
}

function createContext(
  dbState = createD1State(),
  options: { onFailureStatusRead?: (task: TaskRow) => void } = {}
) {
  const storageWrites: TaskRunnerState[] = [];
  const database = createD1Database(dbState, options);
  const rc = {
    env: {
      DATABASE: database,
      OBSERVABILITY_DATABASE: database,
      KV: {},
      NODE_LIFECYCLE: {
        idFromName: vi.fn((id: string) => id),
        get: vi.fn(() => ({
          scheduleWorkspaceDeletion: vi.fn(async () => undefined),
          markIdle: vi.fn(async () => undefined),
        })),
      },
    },
    ctx: {
      storage: {
        put: vi.fn(async (_key: string, state: TaskRunnerState) => {
          storageWrites.push(structuredClone(state));
        }),
      },
    },
    assertRecoveryAuthority: vi.fn(async () => undefined),
  } as unknown as TaskRunnerContext;

  return { dbState, rc, storageWrites };
}

function seedTask(dbState: ReturnType<typeof createD1State>, overrides: Partial<TaskRow> = {}) {
  const task: TaskRow = {
    id: 'task-1',
    status: 'delegated',
    execution_step: 'agent_session',
    error_message: null,
    completed_at: null,
    started_at: null,
    mission_id: null,
    parent_task_id: null,
    ...overrides,
  };
  dbState.tasks.set(task.id, task);
  return task;
}

describe('transitionToInProgress', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('only moves delegated tasks to in_progress, records a status event, and completes DO state as running', async () => {
    const { dbState, rc, storageWrites } = createContext();
    seedTask(dbState);
    const state = makeState();

    await transitionToInProgress(state, rc);

    expect(dbState.tasks.get('task-1')).toMatchObject({
      status: 'in_progress',
      execution_step: 'running',
    });
    expect(dbState.tasks.get('task-1')?.started_at).toBeTruthy();
    expect(dbState.statusEvents).toContainEqual({
      task_id: 'task-1',
      from_status: 'delegated',
      to_status: 'in_progress',
      reason: 'Agent session agent-session-1 created. Task execution started.',
    });
    expect(state.currentStep).toBe('running');
    expect(state.completed).toBe(true);
    expect(storageWrites.at(-1)).toMatchObject({ currentStep: 'running', completed: true });
  });

  it('does not overwrite non-delegated task status', async () => {
    const { dbState, rc, storageWrites } = createContext();
    seedTask(dbState, {
      status: 'completed',
      execution_step: null,
    });
    const state = makeState();

    await transitionToInProgress(state, rc);

    expect(dbState.tasks.get('task-1')).toMatchObject({
      status: 'completed',
      execution_step: null,
      started_at: null,
    });
    expect(dbState.statusEvents).toHaveLength(0);
    expect(state.currentStep).toBe('agent_session');
    expect(state.completed).toBe(true);
    expect(storageWrites.at(-1)).toMatchObject({ currentStep: 'agent_session', completed: true });
  });

  it('makes D1 terminal before completing the DO when recovery leaves an active non-delegated row', async () => {
    const { dbState, rc, storageWrites } = createContext();
    seedTask(dbState, {
      status: 'queued',
      execution_step: 'agent_session',
    });
    const state = makeState();

    await transitionToInProgress(state, rc);

    expect(dbState.tasks.get('task-1')).toMatchObject({
      status: 'failed',
      execution_step: null,
      error_message: 'Task orchestration was superseded before agent handoff completed.',
    });
    expect(dbState.statusEvents).toContainEqual(
      expect.objectContaining({
        task_id: 'task-1',
        from_status: 'queued',
        to_status: 'failed',
      })
    );
    expect(state.completed).toBe(true);
    expect(storageWrites.at(-1)).toMatchObject({ completed: true });
  });

  it('completes the DO as running when a concurrent recovery already advanced D1 to in_progress', async () => {
    // aborted_by_recovery Branch 1: the optimistic delegated->in_progress UPDATE
    // finds 0 rows because a concurrent path already set the row to 'in_progress'.
    // The DO must converge on 'running' WITHOUT failing the task or overwriting D1.
    const { dbState, rc, storageWrites } = createContext();
    seedTask(dbState, {
      status: 'in_progress',
      execution_step: 'running',
    });
    const state = makeState();

    await transitionToInProgress(state, rc);

    expect(dbState.tasks.get('task-1')).toMatchObject({
      status: 'in_progress',
      execution_step: 'running',
    });
    // No new status event and no failTask side effect — D1 is left as-is.
    expect(dbState.statusEvents).toHaveLength(0);
    expect(state.currentStep).toBe('running');
    expect(state.completed).toBe(true);
    expect(storageWrites.at(-1)).toMatchObject({ currentStep: 'running', completed: true });
  });

  it('restores snapshot ownership when a terminal task wins the final handoff race', async () => {
    const { dbState, rc } = createContext();
    seedTask(dbState, { status: 'completed', execution_step: null });
    const state = makeState({
      config: {
        ...makeState().config,
        resumeSnapshotChatSessionId: 'session-race',
        recoverySourceTaskId: 'source-race',
      },
    });

    await transitionToInProgress(state, rc);

    expect(restoreSessionRecoveryHandoffMock).toHaveBeenCalledWith(
      rc.env.DATABASE,
      'task-1',
      'session-race'
    );
    expect(failSessionSnapshotRecoveryMock).toHaveBeenCalled();
    expect(state.currentStep).toBe('agent_session');
    expect(state.completed).toBe(true);
  });
});

describe('failTask', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stopWorkspaceOnNodeMock.mockResolvedValue(undefined);
    sleepSessionMock.mockResolvedValue(true);
  });

  it('does not overwrite tasks that are already terminal', async () => {
    const { dbState, rc, storageWrites } = createContext();
    seedTask(dbState, {
      status: 'completed',
      execution_step: null,
    });
    const state = makeState();

    await failTask(state, 'late failure must not overwrite terminal task', rc);

    expect(dbState.tasks.get('task-1')).toMatchObject({
      status: 'completed',
      execution_step: null,
      error_message: null,
      completed_at: null,
    });
    expect(dbState.statusEvents).toHaveLength(0);
    expect(syncTriggerExecutionStatusMock).not.toHaveBeenCalled();
    expect(storageWrites.at(-1)).toMatchObject({ completed: true });
  });

  it('restores snapshot ownership when another writer terminalizes between failure SELECT and UPDATE', async () => {
    const dbState = createD1State();
    const { rc } = createContext(dbState, {
      onFailureStatusRead: (task) => {
        task.status = 'completed';
        task.execution_step = null;
      },
    });
    seedTask(dbState, { status: 'delegated', execution_step: 'agent_session' });
    const state = makeState({
      config: {
        ...makeState().config,
        resumeSnapshotChatSessionId: 'session-select-update-race',
        recoverySourceTaskId: 'source-select-update-race',
      },
    });

    await failTask(state, 'revoked during failure transition', rc);

    expect(dbState.tasks.get('task-1')?.status).toBe('completed');
    expect(restoreSessionRecoveryHandoffMock).toHaveBeenCalledWith(
      rc.env.DATABASE,
      'task-1',
      'session-select-update-race'
    );
    expect(failSessionSnapshotRecoveryMock).toHaveBeenCalled();
    expect(state.completed).toBe(true);
  });

  it('marks active tasks failed with terminal fields and a status event', async () => {
    const { dbState, rc, storageWrites } = createContext();
    seedTask(dbState, {
      status: 'delegated',
      execution_step: 'agent_session',
    });
    const state = makeState({
      stepResults: { ...makeState().stepResults, chatSessionId: 'session-1' },
    });

    await failTask(state, 'agent session failed permanently', rc);

    expect(dbState.tasks.get('task-1')).toMatchObject({
      status: 'failed',
      execution_step: null,
      error_message: 'agent session failed permanently',
    });
    expect(dbState.tasks.get('task-1')?.completed_at).toBeTruthy();
    expect(dbState.statusEvents).toContainEqual({
      task_id: 'task-1',
      from_status: 'delegated',
      to_status: 'failed',
      reason: 'agent session failed permanently',
    });
    expect(syncTriggerExecutionStatusMock).toHaveBeenCalledWith(
      expect.anything(),
      'task-1',
      'failed',
      'agent session failed permanently'
    );
    expect(storageWrites.at(-1)).toMatchObject({ completed: true });
    expect(persistErrorMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ taskId: 'task-1', sessionId: 'session-1' }),
      rc.env
    );
  });

  it('redacts sensitive failure text before observability persistence', async () => {
    const { dbState, rc } = createContext();
    seedTask(dbState);
    const secret = `sk-ant-${'a'.repeat(32)}`;

    await failTask(makeState(), `provider rejected ${secret}`, rc);

    const persisted = persistErrorMock.mock.calls.at(-1)?.[1];
    expect(persisted?.message).toContain('[REDACTED]');
    expect(persisted?.message).not.toContain(secret);
  });

  it('revokes MCP token on failure and clears it from DO state', async () => {
    const { dbState, rc, storageWrites } = createContext();
    seedTask(dbState);
    const state = makeState({
      stepResults: {
        ...makeState().stepResults,
        mcpToken: 'mcp-token-to-revoke',
      },
    });

    await failTask(state, 'failure revokes token', rc);

    expect(revokeMcpTokenMock).toHaveBeenCalledWith({}, 'mcp-token-to-revoke');
    expect(state.stepResults.mcpToken).toBeNull();
    expect(storageWrites.at(-1)?.stepResults.mcpToken).toBeNull();
  });

  it('updates workspace status when VM cleanup fails and does not mask task failure', async () => {
    const { dbState, rc } = createContext();
    seedTask(dbState);
    dbState.workspaces.set('workspace-1', { id: 'workspace-1', status: 'running' });
    stopWorkspaceOnNodeMock.mockRejectedValueOnce(new Error('VM agent unreachable'));
    const state = makeState();

    await failTask(state, 'workspace cleanup should not mask task failure', rc);

    expect(stopWorkspaceOnNodeMock).toHaveBeenCalledWith('node-1', 'workspace-1', rc.env, 'user-1');
    expect(dbState.workspaces.get('workspace-1')?.status).toBe('stopped');
    expect(dbState.tasks.get('task-1')).toMatchObject({
      status: 'failed',
      error_message: 'workspace cleanup should not mask task failure',
    });
  });

  it('fails only the replacement recovery task and returns the original chat to sleeping', async () => {
    const { dbState, rc } = createContext();
    seedTask(dbState, {
      status: 'delegated',
      execution_step: 'agent_session',
    });
    dbState.workspaces.set('workspace-1', { id: 'workspace-1', status: 'running' });
    const state = makeState({
      stepResults: { ...makeState().stepResults, chatSessionId: 'session-1' },
      config: {
        ...makeState().config,
        resumeSnapshotChatSessionId: 'session-1',
      },
    });

    await failTask(state, 'replacement restore failed', rc);

    expect(dbState.tasks.get('task-1')).toMatchObject({
      status: 'failed',
      error_message: 'replacement restore failed',
    });
    expect(failSessionSnapshotRecoveryMock).toHaveBeenCalledWith(
      expect.anything(),
      rc.env,
      'session-1',
      'task-1',
      'replacement restore failed'
    );
    expect(restoreSessionRecoveryHandoffMock).toHaveBeenCalledWith(
      rc.env.DATABASE,
      'task-1',
      'session-1'
    );
    expect(sleepSessionMock).toHaveBeenCalledWith(rc.env, 'project-1', 'session-1');
    expect(failSessionMock).not.toHaveBeenCalled();
    expect(persistMessageMock).not.toHaveBeenCalled();
    expect(stopWorkspaceOnNodeMock).toHaveBeenCalledWith('node-1', 'workspace-1', rc.env, 'user-1');
  });

  it('strictly destroys an auto-provisioned recovery node when failure precedes workspace creation', async () => {
    const { dbState, rc } = createContext();
    seedTask(dbState, { status: 'delegated', execution_step: 'node_provisioning' });
    const state = makeState({
      currentStep: 'node_provisioning',
      stepResults: {
        ...makeState().stepResults,
        nodeId: 'recovery-node-1',
        autoProvisioned: true,
        workspaceId: null,
        agentSessionId: null,
        agentStarted: false,
      },
      config: {
        ...makeState().config,
        resumeSnapshotChatSessionId: 'recovery-chat-1',
        recoverySourceTaskId: 'source-task-1',
      },
    });

    await failTask(state, 'recovery provisioning lost authority', rc);

    expect(deleteNodeResourcesStrictMock).toHaveBeenCalledWith('recovery-node-1', 'user-1', rc.env);
    expect(cleanupTaskRunMock).not.toHaveBeenCalled();
    expect(rc.env.NODE_LIFECYCLE.get).not.toHaveBeenCalled();
  });
});
