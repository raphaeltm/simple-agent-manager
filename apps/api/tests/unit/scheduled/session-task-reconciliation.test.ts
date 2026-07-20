import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  ensure: vi.fn(),
  drizzle: vi.fn(() => ({ marker: 'db' })),
  log: { info: vi.fn(), warn: vi.fn() },
}));

vi.mock('../../../src/services/session-task-repair', () => ({
  ensureSessionTaskBacked: mocks.ensure,
}));
vi.mock('drizzle-orm/d1', () => ({ drizzle: mocks.drizzle }));
vi.mock('../../../src/lib/logger', () => ({ log: mocks.log }));

import { runSessionTaskReconciliation } from '../../../src/scheduled/session-task-reconciliation';

function makeEnv() {
  const limits: number[] = [];
  const updates: Array<{ taskId: string; sessionId: string }> = [];
  const database = {
    prepare: vi.fn((_sql: string) => ({
      bind: (...args: unknown[]) => ({
        all: async () => {
          limits.push(Number(args[0]));
          return {
            results: [
              { id: 'session-1', project_id: 'project-1', user_id: 'user-1' },
              { id: 'session-2', project_id: 'project-2', user_id: 'user-2' },
            ],
          };
        },
        run: async () => {
          updates.push({ taskId: String(args[0]), sessionId: String(args[1]) });
          return { meta: { changes: args[1] === 'session-1' ? 1 : 0 } };
        },
      }),
      first: async () => ({ count: 3 }),
    })),
  };
  return {
    env: {
      DATABASE: database,
      SESSION_TASK_REPAIR_BATCH_SIZE: '2',
    } as never,
    limits,
    updates,
  };
}

describe('runSessionTaskReconciliation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.ensure.mockResolvedValueOnce({ id: 'task-1' }).mockResolvedValueOnce({ id: 'task-2' });
  });

  it('repairs a bounded page and reports residual/reuse metrics', async () => {
    const { env, limits, updates } = makeEnv();

    const result = await runSessionTaskReconciliation(env);

    expect(limits).toEqual([2]);
    expect(mocks.ensure).toHaveBeenNthCalledWith(1, expect.anything(), env, {
      projectId: 'project-1',
      sessionId: 'session-1',
      fallbackUserId: 'user-1',
    });
    expect(updates).toEqual([
      { taskId: 'task-1', sessionId: 'session-1' },
      { taskId: 'task-2', sessionId: 'session-2' },
    ]);
    expect(result).toEqual({
      scanned: 2,
      repaired: 1,
      reused: 1,
      errors: 0,
      residual: 3,
    });
  });

  it('continues after one repair fails', async () => {
    mocks.ensure.mockReset();
    mocks.ensure
      .mockRejectedValueOnce(new Error('DO unavailable'))
      .mockResolvedValueOnce({ id: 'task-2' });
    const { env } = makeEnv();

    const result = await runSessionTaskReconciliation(env);

    expect(result.errors).toBe(1);
    expect(result.reused).toBe(1);
    expect(mocks.log.warn).toHaveBeenCalledWith(
      'session_task_reconciliation.repair_failed',
      expect.objectContaining({ sessionId: 'session-1', error: 'DO unavailable' })
    );
  });
});
