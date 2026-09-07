import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';

const CLEANUP_IMPORT_TEST_TIMEOUT_MS = 15_000;

const mocks = vi.hoisted(() => ({
  drizzle: vi.fn(),
  stopWorkspaceOnNode: vi.fn(),
  markIdle: vi.fn(),
  stopNodeResources: vi.fn(),
  stopSession: vi.fn(),
  failSession: vi.fn(),
  queueWorkspaceSessionSleep: vi.fn(),
  deleteSessionSnapshotState: vi.fn(),
  cancelVmTaskAdmission: vi.fn(),
  log: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('drizzle-orm/d1', () => ({
  drizzle: (...args: unknown[]) => mocks.drizzle(...args),
}));

vi.mock('../../../src/services/node-agent', () => ({
  stopWorkspaceOnNode: (...args: unknown[]) => mocks.stopWorkspaceOnNode(...args),
}));

vi.mock('../../../src/services/node-lifecycle', () => ({
  markIdle: (...args: unknown[]) => mocks.markIdle(...args),
}));

vi.mock('../../../src/services/nodes', () => ({
  stopNodeResources: (...args: unknown[]) => mocks.stopNodeResources(...args),
}));

vi.mock('../../../src/services/project-data', () => ({
  stopSession: (...args: unknown[]) => mocks.stopSession(...args),
  failSession: (...args: unknown[]) => mocks.failSession(...args),
}));

vi.mock('../../../src/services/session-sleep', () => ({
  queueWorkspaceSessionSleep: (...args: unknown[]) => mocks.queueWorkspaceSessionSleep(...args),
}));

vi.mock('../../../src/services/session-snapshots', () => ({
  deleteSessionSnapshotState: (...args: unknown[]) => mocks.deleteSessionSnapshotState(...args),
}));

vi.mock('../../../src/services/vm-admission-control', () => ({
  cancelVmTaskAdmission: (...args: unknown[]) => mocks.cancelVmTaskAdmission(...args),
}));

vi.mock('../../../src/lib/logger', () => ({
  log: mocks.log,
}));

function buildDb(selectRows: unknown[][]) {
  const updates: Array<Record<string, unknown>> = [];
  const select = vi.fn(() => {
    const rows = selectRows.shift() ?? [];
    const chain = {
      from: vi.fn(() => chain),
      where: vi.fn(() => chain),
      limit: vi.fn(() => Promise.resolve(rows)),
      then: (resolve: (value: unknown[]) => unknown, reject?: (reason: unknown) => unknown) =>
        Promise.resolve(rows).then(resolve, reject),
    };
    return chain;
  });
  const update = vi.fn(() => ({
    set: vi.fn((values: Record<string, unknown>) => {
      updates.push(values);
      return {
        where: vi.fn(() => Promise.resolve()),
      };
    }),
  }));

  return { select, update, updates };
}

// NOTE: the `cleanupTaskRun` unit tests that lived here were removed in favour of
// `tests/unit/services/task-cleanup-cross-tenant.test.ts`, which exercises the same behaviour
// against a real in-memory SQLite engine. They asserted ownership/runtime-branch behaviour through
// a `buildDb` mock whose `.where()` ignored its arguments, so they could not evaluate the WHERE
// predicates the guards are made of — and their fixtures omitted `workspaces.user_id` entirely,
// which let them assert the task creator where the code should use the workspace owner.
// See .claude/rules/28-credential-resolution-fallback-tests.md, prohibited pattern #5.
//
// `buildDb` is retained below: the cleanupTerminalTaskResources tests assert CALL ORDERING
// (session stop/fail before runtime cleanup), which a mock models faithfully.

describe('cleanupTerminalTaskResources', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.stopSession.mockResolvedValue(undefined);
    mocks.failSession.mockResolvedValue(undefined);
    mocks.queueWorkspaceSessionSleep.mockResolvedValue(undefined);
    mocks.deleteSessionSnapshotState.mockResolvedValue(true);
    mocks.cancelVmTaskAdmission.mockResolvedValue(undefined);
  });

  it('queues completed-session sleep without cleaning up the current prompt runtime', async () => {
    const order: string[] = [];
    const db = buildDb([
      [
        {
          id: 'task-terminal-1',
          projectId: 'project-terminal-1',
          workspaceId: 'workspace-terminal-1',
          errorMessage: null,
        },
      ],
      [{ chatSessionId: 'session-terminal-1', userId: 'workspace-owner-1' }],
    ]);
    mocks.drizzle.mockReturnValue(db);
    mocks.queueWorkspaceSessionSleep.mockImplementation(async () => {
      order.push('queueWorkspaceSessionSleep');
    });

    vi.doMock('../../../src/services/task-runner', () => ({
      cleanupTaskRun: async () => {
        order.push('cleanupTaskRun');
      },
    }));

    const { cleanupTerminalTaskResources } =
      await import('../../../src/services/task-terminal-cleanup');
    const env = { DATABASE: {} } as Env;

    await cleanupTerminalTaskResources(env, 'task-terminal-1', { status: 'completed' });

    expect(mocks.cancelVmTaskAdmission).toHaveBeenCalledWith(
      env,
      'task-terminal-1',
      'task_completed_cleanup'
    );
    expect(mocks.queueWorkspaceSessionSleep).toHaveBeenCalledWith(
      env,
      expect.objectContaining({
        workspaceId: 'workspace-terminal-1',
        userId: 'workspace-owner-1',
        sleepAfterMs: 0,
      })
    );
    expect(mocks.stopSession).not.toHaveBeenCalled();
    expect(order).toEqual(['queueWorkspaceSessionSleep']);
  }, CLEANUP_IMPORT_TEST_TIMEOUT_MS);

  it('fails the chat session before cleanup when task status is failed', async () => {
    const order: string[] = [];
    const db = buildDb([
      [
        {
          id: 'task-terminal-failed',
          projectId: 'project-terminal-1',
          workspaceId: 'workspace-terminal-1',
          errorMessage: 'runner failed',
        },
      ],
      [{ chatSessionId: 'session-terminal-1' }],
    ]);
    mocks.drizzle.mockReturnValue(db);
    mocks.failSession.mockImplementation(async () => {
      order.push('failSession');
    });

    vi.doMock('../../../src/services/task-runner', () => ({
      cleanupTaskRun: async () => {
        order.push('cleanupTaskRun');
      },
    }));

    const { cleanupTerminalTaskResources } =
      await import('../../../src/services/task-terminal-cleanup');
    const env = { DATABASE: {} } as Env;

    await cleanupTerminalTaskResources(env, 'task-terminal-failed', { status: 'failed' });

    expect(mocks.cancelVmTaskAdmission).toHaveBeenCalledWith(
      env,
      'task-terminal-failed',
      'task_failed'
    );
    expect(mocks.failSession).toHaveBeenCalledWith(
      env,
      'project-terminal-1',
      'session-terminal-1',
      'runner failed'
    );
    expect(order).toEqual(['failSession', 'cleanupTaskRun']);
  }, CLEANUP_IMPORT_TEST_TIMEOUT_MS);

  it('deletes retained state before stopping an explicitly archived session', async () => {
    const order: string[] = [];
    const db = buildDb([
      [
        {
          id: 'task-terminal-archive',
          projectId: 'project-terminal-1',
          workspaceId: 'workspace-terminal-1',
          errorMessage: null,
        },
      ],
      [{ chatSessionId: 'session-terminal-1', userId: 'workspace-owner-1' }],
    ]);
    mocks.drizzle.mockReturnValue(db);
    mocks.deleteSessionSnapshotState.mockImplementation(async () => {
      order.push('deleteSessionSnapshotState');
      return true;
    });
    mocks.stopSession.mockImplementation(async () => {
      order.push('stopSession');
    });

    vi.doMock('../../../src/services/task-runner', () => ({
      cleanupTaskRun: async () => {
        order.push('cleanupTaskRun');
      },
    }));

    const { cleanupTerminalTaskResources } =
      await import('../../../src/services/task-terminal-cleanup');
    const env = { DATABASE: {} } as Env;

    await cleanupTerminalTaskResources(env, 'task-terminal-archive', {
      status: 'completed',
      destructiveSessionEnd: true,
    });

    expect(mocks.queueWorkspaceSessionSleep).not.toHaveBeenCalled();
    expect(order).toEqual(['deleteSessionSnapshotState', 'stopSession', 'cleanupTaskRun']);
  }, CLEANUP_IMPORT_TEST_TIMEOUT_MS);
});
