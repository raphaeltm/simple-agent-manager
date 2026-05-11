import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import * as projectDataService from '../../../src/services/project-data';
import { finalizeTaskRun } from '../../../src/services/task-finalization';
import { cleanupTaskRun } from '../../../src/services/task-runner';

vi.mock('../../../src/services/project-data', () => ({
  stopActiveSessionsForTask: vi.fn(async () => ({ stopped: 0, sessionIds: [] })),
}));

vi.mock('../../../src/services/task-runner', () => ({
  cleanupTaskRun: vi.fn(async () => {}),
}));

describe('finalizeTaskRun', () => {
  const env = {} as Env;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('stops active task sessions for terminal task events', async () => {
    await finalizeTaskRun(env, {
      taskId: 'task-1',
      projectId: 'project-1',
      status: 'failed',
      taskMode: 'task',
      cleanupWorkspace: false,
    });

    expect(projectDataService.stopActiveSessionsForTask).toHaveBeenCalledWith(env, 'project-1', 'task-1');
    expect(cleanupTaskRun).not.toHaveBeenCalled();
  });

  it('cleans up workspace immediately for completed task-mode finalization', async () => {
    await finalizeTaskRun(env, {
      taskId: 'task-2',
      projectId: 'project-1',
      status: 'completed',
      taskMode: 'task',
      cleanupWorkspace: true,
      warmTimeoutOverrideMs: 123,
    });

    expect(projectDataService.stopActiveSessionsForTask).toHaveBeenCalledWith(env, 'project-1', 'task-2');
    expect(cleanupTaskRun).toHaveBeenCalledWith('task-2', env, 123);
  });

  it('schedules completed workspace cleanup with waitUntil when provided', async () => {
    const waitUntil = vi.fn();

    await finalizeTaskRun(env, {
      taskId: 'task-2',
      projectId: 'project-1',
      status: 'completed',
      taskMode: 'task',
      cleanupWorkspace: true,
      waitUntil,
    });

    expect(projectDataService.stopActiveSessionsForTask).toHaveBeenCalledWith(env, 'project-1', 'task-2');
    expect(cleanupTaskRun).toHaveBeenCalledWith('task-2', env, undefined);
    expect(waitUntil).toHaveBeenCalledOnce();
    expect(waitUntil.mock.calls[0]?.[0]).toBeInstanceOf(Promise);
  });

  it('does not clean up workspace for failed or cancelled task finalization', async () => {
    await finalizeTaskRun(env, {
      taskId: 'task-3',
      projectId: 'project-1',
      status: 'cancelled',
      taskMode: 'task',
      cleanupWorkspace: true,
    });

    expect(projectDataService.stopActiveSessionsForTask).toHaveBeenCalledWith(env, 'project-1', 'task-3');
    expect(cleanupTaskRun).not.toHaveBeenCalled();
  });
});
