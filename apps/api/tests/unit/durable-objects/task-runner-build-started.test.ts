import { describe, expect, it, vi } from 'vitest';

import type { TaskRunnerState } from '../../../src/durable-objects/task-runner/types';

vi.mock('cloudflare:workers', () => ({
  DurableObject: class {},
}));

function makeState(): TaskRunnerState {
  return {
    version: 1,
    taskId: 'task-1',
    projectId: 'project-1',
    userId: 'user-1',
    currentStep: 'workspace_ready',
    stepResults: {
      nodeId: 'node-1',
      autoProvisioned: false,
      claimedWarmNodeId: null,
      workspaceId: 'ws-1',
      chatSessionId: null,
      agentSessionId: null,
      agentStarted: false,
      mcpToken: null,
      provisionedVmSize: null,
    },
    config: {
      taskTitle: 'Task',
      repository: 'owner/repo',
      branch: 'main',
      defaultBranch: 'main',
      vmSize: 'cx22',
      vmLocation: 'fsn1',
      outputBranch: 'task/task-1',
      agentType: 'openai-codex',
    } as TaskRunnerState['config'],
    retryCount: 0,
    workspaceReadyReceived: false,
    workspaceReadyStatus: null,
    workspaceErrorMessage: null,
    createdAt: 1,
    lastStepAt: 1,
    provisioningStartedAt: null,
    admissionScopeKey: null,
    admissionLeaseToken: null,
    agentReadyStartedAt: null,
    workspaceDispatchStartedAt: null,
    workspaceDispatchAttempts: 0,
    workspaceDispatchLastAttemptAt: null,
    workspaceDispatchLastError: null,
    workspaceDispatchAckedAt: Date.now() - 20 * 60 * 1000,
    workspaceReadyStartedAt: Date.now() - 20 * 60 * 1000,
    completed: false,
  };
}

describe('TaskRunner build-started callback handling', () => {
  it('resets workspace-ready timeout from the build-started callback', async () => {
    const { TaskRunner } = await import('../../../src/durable-objects/task-runner');
    const state = makeState();
    const put = vi.fn(async (_key: string, value: TaskRunnerState) => {
      Object.assign(state, value);
    });
    const setAlarm = vi.fn(async () => undefined);
    const runner = Object.create(TaskRunner.prototype) as TaskRunner & {
      ctx: { storage: { put: typeof put; setAlarm: typeof setAlarm } };
      getState: () => Promise<TaskRunnerState>;
    };
    const storage = {
      put,
      setAlarm,
      get: async () => structuredClone(state),
      transaction: async <T>(callback: (transaction: DurableObjectTransaction) => Promise<T>) =>
        callback(storage as unknown as DurableObjectTransaction),
    };
    runner.ctx = { storage };
    runner.getState = vi.fn(async () => state);

    const before = state.workspaceReadyStartedAt;
    await runner.notifyWorkspaceBuildStarted('ws-1');

    expect(state.workspaceReadyStartedAt).toBeGreaterThan(before ?? 0);
    expect(put).toHaveBeenCalledWith('state', state);
    expect(setAlarm).toHaveBeenCalled();
  }, 15_000);

  it('ignores build-started callbacks for a different workspace', async () => {
    const { TaskRunner } = await import('../../../src/durable-objects/task-runner');
    const state = makeState();
    const put = vi.fn();
    const setAlarm = vi.fn();
    const runner = Object.create(TaskRunner.prototype) as TaskRunner & {
      ctx: { storage: { put: typeof put; setAlarm: typeof setAlarm } };
      getState: () => Promise<TaskRunnerState>;
    };
    runner.ctx = { storage: { put, setAlarm } };
    runner.getState = vi.fn(async () => state);

    await runner.notifyWorkspaceBuildStarted('ws-other');

    expect(put).not.toHaveBeenCalled();
    expect(setAlarm).not.toHaveBeenCalled();
  });
});
