/**
 * Behavioral tests for task completion callback handling (T033).
 *
 * Replaces the prior source-contract tests (readFileSync + toContain) with
 * behavioral assertions that exercise the real callback route and the real
 * terminal cleanup service, proving the contracts hold at runtime.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../src/env';

const mocks = vi.hoisted(() => ({
  drizzle: vi.fn(),
  cleanupTaskRun: vi.fn(),
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

vi.mock('../../src/services/task-runner', () => ({
  cleanupTaskRun: (...args: unknown[]) => mocks.cleanupTaskRun(...args),
}));

vi.mock('../../src/services/project-data', () => ({
  stopSession: (...args: unknown[]) => mocks.stopSession(...args),
  failSession: (...args: unknown[]) => mocks.failSession(...args),
}));

vi.mock('../../src/lib/logger', () => ({
  log: mocks.log,
}));

function buildDb(selectRows: unknown[][]) {
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

  return { select };
}

describe('cleanupTerminalTaskResources behavioral tests', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.stopSession.mockResolvedValue(undefined);
    mocks.failSession.mockResolvedValue(undefined);
    mocks.cleanupTaskRun.mockResolvedValue(undefined);
  });

  it('stops the chat session then invokes cleanupTaskRun for completed tasks', async () => {
    const order: string[] = [];
    const db = buildDb([
      [{
        id: 'task-1',
        projectId: 'proj-1',
        workspaceId: 'ws-1',
        errorMessage: null,
      }],
      [{ chatSessionId: 'session-1' }],
    ]);
    mocks.drizzle.mockReturnValue(db);
    mocks.stopSession.mockImplementation(async () => { order.push('stopSession'); });
    mocks.cleanupTaskRun.mockImplementation(async () => { order.push('cleanupTaskRun'); });

    const { cleanupTerminalTaskResources } = await import('../../src/services/task-terminal-cleanup');
    const env = { DATABASE: {} } as Env;

    await cleanupTerminalTaskResources(env, 'task-1', { status: 'completed' });

    expect(mocks.stopSession).toHaveBeenCalledWith(env, 'proj-1', 'session-1');
    expect(mocks.cleanupTaskRun).toHaveBeenCalledWith('task-1', env, undefined, undefined);
    expect(order).toEqual(['stopSession', 'cleanupTaskRun']);
  });

  it('fails the chat session for failed tasks and propagates error message', async () => {
    const db = buildDb([
      [{
        id: 'task-2',
        projectId: 'proj-2',
        workspaceId: 'ws-2',
        errorMessage: 'agent crashed',
      }],
      [{ chatSessionId: 'session-2' }],
    ]);
    mocks.drizzle.mockReturnValue(db);

    const { cleanupTerminalTaskResources } = await import('../../src/services/task-terminal-cleanup');
    const env = { DATABASE: {} } as Env;

    await cleanupTerminalTaskResources(env, 'task-2', { status: 'failed' });

    expect(mocks.failSession).toHaveBeenCalledWith(env, 'proj-2', 'session-2', 'agent crashed');
    expect(mocks.cleanupTaskRun).toHaveBeenCalledWith('task-2', env, undefined, undefined);
  });

  it('threads requiredUserId through to cleanupTaskRun for caller-scoped cleanup', async () => {
    const db = buildDb([
      [{
        id: 'task-3',
        projectId: 'proj-3',
        workspaceId: 'ws-3',
        errorMessage: null,
      }],
      [{ chatSessionId: 'session-3' }],
    ]);
    mocks.drizzle.mockReturnValue(db);

    const { cleanupTerminalTaskResources } = await import('../../src/services/task-terminal-cleanup');
    const env = { DATABASE: {} } as Env;

    await cleanupTerminalTaskResources(env, 'task-3', {
      status: 'cancelled',
      requiredUserId: 'cancelling-user',
    });

    expect(mocks.cleanupTaskRun).toHaveBeenCalledWith('task-3', env, undefined, 'cancelling-user');
  });

  it('skips cleanup when task has no workspace', async () => {
    const db = buildDb([
      [{
        id: 'task-4',
        projectId: null,
        workspaceId: null,
        errorMessage: null,
      }],
    ]);
    mocks.drizzle.mockReturnValue(db);

    const { cleanupTerminalTaskResources } = await import('../../src/services/task-terminal-cleanup');
    const env = { DATABASE: {} } as Env;

    await cleanupTerminalTaskResources(env, 'task-4', { status: 'completed' });

    expect(mocks.stopSession).not.toHaveBeenCalled();
    expect(mocks.cleanupTaskRun).not.toHaveBeenCalled();
  });
});
