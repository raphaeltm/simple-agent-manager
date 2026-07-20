import { beforeEach, describe, expect, it, vi } from 'vitest';

const instantSessionMocks = vi.hoisted(() => ({
  launchInstantSession: vi.fn(),
}));

const taskFailureMocks = vi.hoisted(() => ({
  markQueuedTaskFailed: vi.fn(),
}));

vi.mock('../../../src/services/instant-session', () => ({
  launchInstantSession: instantSessionMocks.launchInstantSession,
}));

vi.mock('../../../src/services/task-failure', () => ({
  markQueuedTaskFailed: taskFailureMocks.markQueuedTaskFailed,
}));

import { log } from '../../../src/lib/logger';
import {
  type LaunchDispatchedInstantInput,
  launchDispatchedInstantSession,
} from '../../../src/routes/mcp/dispatch-instant';

function makeInput(): LaunchDispatchedInstantInput {
  return {
    taskId: 'task-1',
    project: { id: 'proj-1' } as LaunchDispatchedInstantInput['project'],
    userId: 'user-1',
    fullDescription: 'Fix the bug',
    agentType: 'openai-codex',
    branch: 'main',
    taskMode: 'task',
  };
}

const fakeDb = { marker: 'db' } as never;

describe('launchDispatchedInstantSession', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    taskFailureMocks.markQueuedTaskFailed.mockResolvedValue(true);
  });

  it('offloads the launch to waitUntil and resolves before the launch settles', async () => {
    let resolveLaunch: (value: unknown) => void = () => undefined;
    instantSessionMocks.launchInstantSession.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveLaunch = resolve;
      })
    );
    const waited: Promise<unknown>[] = [];
    const execCtx = {
      waitUntil: (promise: Promise<unknown>) => {
        waited.push(promise);
      },
    };

    // Resolves immediately while the launch promise is still pending
    await expect(
      launchDispatchedInstantSession(fakeDb, {} as never, makeInput(), execCtx)
    ).resolves.toBeUndefined();
    expect(waited).toHaveLength(1);
    expect(instantSessionMocks.launchInstantSession).toHaveBeenCalledTimes(1);

    resolveLaunch({ taskId: 'task-1', runtime: 'cf-container' });
    await expect(waited[0]).resolves.toBeUndefined();
    expect(taskFailureMocks.markQueuedTaskFailed).not.toHaveBeenCalled();
  });

  it('marks the task failed and logs when a waitUntil-offloaded launch rejects', async () => {
    instantSessionMocks.launchInstantSession.mockRejectedValueOnce(
      new Error('container pool exhausted')
    );
    const logSpy = vi.spyOn(log, 'error').mockImplementation(() => undefined);
    const waited: Promise<unknown>[] = [];
    const execCtx = {
      waitUntil: (promise: Promise<unknown>) => {
        waited.push(promise);
      },
    };

    await expect(
      launchDispatchedInstantSession(fakeDb, {} as never, makeInput(), execCtx)
    ).resolves.toBeUndefined();

    // The rejection is captured: structured log + queued-guarded task failure
    expect(waited).toHaveLength(1);
    await expect(waited[0]).resolves.toBeUndefined();
    expect(logSpy).toHaveBeenCalledWith(
      'mcp.dispatch_task.instant_launch_failed',
      expect.objectContaining({
        taskId: 'task-1',
        projectId: 'proj-1',
        error: 'container pool exhausted',
      })
    );
    expect(taskFailureMocks.markQueuedTaskFailed).toHaveBeenCalledWith(
      fakeDb,
      'task-1',
      'Instant launch failed: container pool exhausted'
    );
  });

  it('marks the task failed and propagates the rejection without an execution context', async () => {
    instantSessionMocks.launchInstantSession.mockRejectedValueOnce(
      new Error('container pool exhausted')
    );
    vi.spyOn(log, 'error').mockImplementation(() => undefined);

    await expect(
      launchDispatchedInstantSession(fakeDb, {} as never, makeInput(), undefined)
    ).rejects.toThrow('container pool exhausted');
    expect(taskFailureMocks.markQueuedTaskFailed).toHaveBeenCalledWith(
      fakeDb,
      'task-1',
      'Instant launch failed: container pool exhausted'
    );
  });

  it('still propagates the launch failure when persisting the failure also throws', async () => {
    instantSessionMocks.launchInstantSession.mockRejectedValueOnce(
      new Error('container pool exhausted')
    );
    taskFailureMocks.markQueuedTaskFailed.mockRejectedValueOnce(new Error('D1 unavailable'));
    const logSpy = vi.spyOn(log, 'error').mockImplementation(() => undefined);

    await expect(
      launchDispatchedInstantSession(fakeDb, {} as never, makeInput(), undefined)
    ).rejects.toThrow('container pool exhausted');
    expect(logSpy).toHaveBeenCalledWith(
      'mcp.dispatch_task.instant_failure_persist_failed',
      expect.objectContaining({ taskId: 'task-1', error: 'D1 unavailable' })
    );
  });

  it('resolves the inline launch when it succeeds without an execution context', async () => {
    instantSessionMocks.launchInstantSession.mockResolvedValueOnce({
      taskId: 'task-1',
      runtime: 'cf-container',
    });

    await expect(
      launchDispatchedInstantSession(fakeDb, {} as never, makeInput(), undefined)
    ).resolves.toBeUndefined();
    expect(instantSessionMocks.launchInstantSession).toHaveBeenCalledTimes(1);
    expect(taskFailureMocks.markQueuedTaskFailed).not.toHaveBeenCalled();
  });
});
