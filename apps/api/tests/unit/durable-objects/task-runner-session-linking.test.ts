import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ensureSessionLinked } from '../../../src/durable-objects/task-runner/state-machine';
import type {
  TaskRunnerContext,
  TaskRunnerState,
} from '../../../src/durable-objects/task-runner/types';

const { linkSessionToWorkspaceMock, scheduleIdleCleanupMock } = vi.hoisted(() => ({
  linkSessionToWorkspaceMock: vi.fn(async () => {}),
  scheduleIdleCleanupMock: vi.fn(async () => ({ cleanupAt: Date.now() + 60_000 })),
}));

vi.mock('../../../src/services/project-data', () => ({
  linkSessionToWorkspace: linkSessionToWorkspaceMock,
  scheduleIdleCleanup: scheduleIdleCleanupMock,
}));

function createState(taskMode: 'task' | 'conversation' = 'task'): TaskRunnerState {
  return {
    taskId: 'task-1',
    projectId: 'project-1',
    userId: 'user-1',
    stepResults: {
      chatSessionId: 'session-1',
    },
    config: {
      taskMode,
    },
  } as TaskRunnerState;
}

function createContext() {
  const run = vi.fn(async () => ({ meta: { changes: 1 } }));
  const bind = vi.fn(() => ({ run }));
  const prepare = vi.fn(() => ({ bind }));
  const env = {
    DATABASE: { prepare },
  };

  return {
    rc: {
      env,
      ctx: {} as DurableObjectState,
    } as TaskRunnerContext,
    env,
    prepare,
    bind,
    run,
  };
}

describe('ensureSessionLinked', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('schedules idle cleanup for task-mode sessions after linking to the workspace', async () => {
    const state = createState('task');
    const { rc, env } = createContext();

    await ensureSessionLinked(state, 'ws-1', rc);

    expect(linkSessionToWorkspaceMock).toHaveBeenCalledWith(
      env,
      'project-1',
      'session-1',
      'ws-1',
    );
    expect(scheduleIdleCleanupMock).toHaveBeenCalledWith(
      env,
      'project-1',
      'session-1',
      'ws-1',
      'task-1',
    );
  });

  it('does not schedule idle cleanup for conversation-mode sessions', async () => {
    const state = createState('conversation');
    const { rc } = createContext();

    await ensureSessionLinked(state, 'ws-1', rc);

    expect(linkSessionToWorkspaceMock).toHaveBeenCalledOnce();
    expect(scheduleIdleCleanupMock).not.toHaveBeenCalled();
  });
});
