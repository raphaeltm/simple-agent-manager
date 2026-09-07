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

function createContext(
  options: {
    taskUpdateChanges?: number;
    taskRow?: { chat_session_id: string | null; workspace_id: string | null } | null;
  } = {}
) {
  const statements: Array<{ sql: string; params: unknown[] }> = [];
  const prepare = vi.fn((sql: string) => ({
    bind: vi.fn((...params: unknown[]) => {
      statements.push({ sql, params });
      return {
        run: vi.fn(async () => ({
          meta: {
            changes: sql.includes('UPDATE tasks')
              ? (options.taskUpdateChanges ?? 1)
              : 1,
          },
        })),
        first: vi.fn(async () => options.taskRow ?? null),
      };
    }),
  }));
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
    statements,
  };
}

describe('ensureSessionLinked', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('schedules idle cleanup for task-mode sessions after linking to the workspace', async () => {
    const state = createState('task');
    const { rc, env, statements } = createContext();

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
    expect(
      statements.find((statement) => statement.sql.includes('UPDATE tasks'))?.params
    ).toEqual(['session-1', 'ws-1', expect.any(String), 'task-1', 'session-1', 'ws-1']);
  });

  it('does not schedule idle cleanup for conversation-mode sessions', async () => {
    const state = createState('conversation');
    const { rc } = createContext();

    await ensureSessionLinked(state, 'ws-1', rc);

    expect(linkSessionToWorkspaceMock).toHaveBeenCalledOnce();
    expect(scheduleIdleCleanupMock).not.toHaveBeenCalled();
  });

  it('fails closed when the task row is already linked to a different session', async () => {
    const state = createState('task');
    const { rc } = createContext({
      taskUpdateChanges: 0,
      taskRow: { chat_session_id: 'session-other', workspace_id: 'ws-1' },
    });

    await expect(ensureSessionLinked(state, 'ws-1', rc)).rejects.toThrow(
      'conflicting session/workspace linkage'
    );
    expect(linkSessionToWorkspaceMock).not.toHaveBeenCalled();
    expect(scheduleIdleCleanupMock).not.toHaveBeenCalled();
  });
});
