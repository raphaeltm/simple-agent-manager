import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';

const mocks = vi.hoisted(() => ({
  drizzle: vi.fn(),
  stopWorkspaceOnNode: vi.fn(),
  markIdle: vi.fn(),
  stopNodeResources: vi.fn(),
  stopSession: vi.fn(),
  failSession: vi.fn(),
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

describe('cleanupTaskRun', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.stopWorkspaceOnNode.mockResolvedValue(undefined);
    mocks.markIdle.mockResolvedValue(undefined);
    mocks.stopNodeResources.mockResolvedValue(undefined);
    mocks.stopSession.mockResolvedValue(undefined);
    mocks.failSession.mockResolvedValue(undefined);
  });

  it('destroys cf-container task nodes instead of warming or only stopping a workspace', async () => {
    const db = buildDb([
      [{
        id: 'task-cf-1',
        userId: 'user-cf-1',
        workspaceId: 'workspace-cf-1',
        autoProvisionedNodeId: 'node-cf-1',
      }],
      [{
        id: 'workspace-cf-1',
        nodeId: 'node-cf-1',
        status: 'running',
      }],
      [{
        id: 'node-cf-1',
        runtime: 'cf-container',
      }],
    ]);
    mocks.drizzle.mockReturnValue(db);

    const { cleanupTaskRun } = await import('../../../src/services/task-runner');
    const env = { DATABASE: {}, TASK_RUN_CLEANUP_DELAY_MS: '0' } as Env;

    await cleanupTaskRun('task-cf-1', env);

    expect(mocks.stopNodeResources).toHaveBeenCalledWith('node-cf-1', 'user-cf-1', env);
    expect(mocks.stopWorkspaceOnNode).not.toHaveBeenCalled();
    expect(mocks.markIdle).not.toHaveBeenCalled();
    expect(db.updates).toEqual([]);
  });

  it('preserves VM cleanup behavior for non-container nodes', async () => {
    const db = buildDb([
      [{
        id: 'task-vm-1',
        userId: 'user-vm-1',
        workspaceId: 'workspace-vm-1',
        autoProvisionedNodeId: 'node-vm-1',
      }],
      [{
        id: 'workspace-vm-1',
        nodeId: 'node-vm-1',
        status: 'running',
      }],
      [{
        id: 'node-vm-1',
        runtime: 'vm',
      }],
      [{
        id: 'node-vm-1',
        status: 'running',
        warmSince: null,
      }],
      [],
    ]);
    mocks.drizzle.mockReturnValue(db);
    const env = {
      DATABASE: {},
      TASK_RUN_CLEANUP_DELAY_MS: '0',
      NODE_LIFECYCLE: {
        idFromName: vi.fn((id: string) => id),
        get: vi.fn(() => ({ scheduleWorkspaceDeletion: vi.fn() })),
      },
    } as unknown as Env;

    const { cleanupTaskRun } = await import('../../../src/services/task-runner');

    await cleanupTaskRun('task-vm-1', env);

    expect(mocks.stopWorkspaceOnNode).toHaveBeenCalledWith(
      'node-vm-1',
      'workspace-vm-1',
      env,
      'user-vm-1'
    );
    expect(mocks.stopNodeResources).not.toHaveBeenCalled();
    expect(mocks.markIdle).toHaveBeenCalledWith(env, 'node-vm-1', 'user-vm-1', undefined);
  });
});

describe('cleanupTerminalTaskResources', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.stopSession.mockResolvedValue(undefined);
    mocks.failSession.mockResolvedValue(undefined);
  });

  it('stops the chat session before invoking task runtime cleanup', async () => {
    const order: string[] = [];
    const db = buildDb([
      [{
        id: 'task-terminal-1',
        projectId: 'project-terminal-1',
        workspaceId: 'workspace-terminal-1',
        errorMessage: null,
      }],
      [{ chatSessionId: 'session-terminal-1' }],
    ]);
    mocks.drizzle.mockReturnValue(db);
    mocks.stopSession.mockImplementation(async () => {
      order.push('stopSession');
    });

    vi.doMock('../../../src/services/task-runner', () => ({
      cleanupTaskRun: async () => {
        order.push('cleanupTaskRun');
      },
    }));

    const { cleanupTerminalTaskResources } = await import('../../../src/services/task-terminal-cleanup');
    const env = { DATABASE: {} } as Env;

    await cleanupTerminalTaskResources(env, 'task-terminal-1', { status: 'completed' });

    expect(mocks.stopSession).toHaveBeenCalledWith(
      env,
      'project-terminal-1',
      'session-terminal-1'
    );
    expect(order).toEqual(['stopSession', 'cleanupTaskRun']);
  });

  it('fails the chat session before cleanup when task status is failed', async () => {
    const order: string[] = [];
    const db = buildDb([
      [{
        id: 'task-terminal-failed',
        projectId: 'project-terminal-1',
        workspaceId: 'workspace-terminal-1',
        errorMessage: 'runner failed',
      }],
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

    const { cleanupTerminalTaskResources } = await import('../../../src/services/task-terminal-cleanup');
    const env = { DATABASE: {} } as Env;

    await cleanupTerminalTaskResources(env, 'task-terminal-failed', { status: 'failed' });

    expect(mocks.failSession).toHaveBeenCalledWith(
      env,
      'project-terminal-1',
      'session-terminal-1',
      'runner failed'
    );
    expect(order).toEqual(['failSession', 'cleanupTaskRun']);
  });
});
