import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/lib/ulid', () => ({
  ulid: vi.fn()
    .mockReturnValueOnce('01TASKMODETASKID')
    .mockReturnValueOnce('01TASKMODESTATUS')
    .mockReturnValue('01TASKMODEOTHER'),
}));

import {
  buildDispatchCtx,
  getDispatchTaskMocks,
  resetDispatchTaskMocks,
} from './sam-dispatch-test-helpers';

const { dispatchTask } = await import('../../../src/durable-objects/sam-session/tools/dispatch-task');

const dispatchTaskMocks = getDispatchTaskMocks();

function buildCtx() {
  return buildDispatchCtx().ctx;
}

describe('SAM dispatch_task taskMode visibility', () => {
  beforeEach(() => {
    resetDispatchTaskMocks();
  });

  it('includes taskMode in the dispatch response', async () => {
    const result = await dispatchTask(
      { projectId: 'proj-1', description: 'Build the feature', taskMode: 'task' },
      buildCtx(),
    ) as { taskMode?: string };

    expect(result.taskMode).toBe('task');
  });

  it('includes a warning when dispatch resolves to conversation mode', async () => {
    const result = await dispatchTask(
      { projectId: 'proj-1', description: 'Discuss the implementation', taskMode: 'conversation' },
      buildCtx(),
    ) as { taskMode?: string; warning?: string };

    expect(result.taskMode).toBe('conversation');
    expect(result.warning).toContain('will not auto-complete');
    expect(result.warning).toContain('send_message_to_subtask');
    expect(result.warning).toContain('get_session_messages');
    expect(result.warning).toContain('taskMode: "task"');
  });

  it('defaults to task mode even with a lightweight workspace profile', async () => {
    const result = await dispatchTask(
      { projectId: 'proj-1', description: 'Quick delegated task', workspaceProfile: 'lightweight' },
      buildCtx(),
    ) as { taskMode?: string };

    expect(result.taskMode).toBe('task');
    expect(dispatchTaskMocks.startTaskRunnerDO).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        workspaceProfile: 'lightweight',
        taskMode: 'task',
      }),
    );
    const taskRunnerInput = dispatchTaskMocks.startTaskRunnerDO.mock.calls[0]?.[1];
    expect(taskRunnerInput.branch).toBe(taskRunnerInput.outputBranch);
    expect(taskRunnerInput.branch).toMatch(/^sam\//);
  });

  it('blocks before provisioning when SAM-session GitHub owner access is revoked', async () => {
    dispatchTaskMocks.requireRepositoryOwnerAccess.mockRejectedValueOnce(
      new Error('Repository access is no longer available'),
    );

    const result = await dispatchTask(
      { projectId: 'proj-1', description: 'Build the feature', taskMode: 'task' },
      buildCtx(),
    ) as { error?: string };

    expect(result.error).toContain('Repository access is no longer available');
    expect(dispatchTaskMocks.requireRepositoryOwnerAccess).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ id: 'proj-1', repository: 'owner/repo' }),
      'user-1',
      'sam-session-dispatch',
    );
    expect(dispatchTaskMocks.startTaskRunnerDO).not.toHaveBeenCalled();
  });
});
