/**
 * Unit tests for the trigger execution sync helper.
 *
 * Verifies that syncTriggerExecutionStatus correctly updates trigger_executions
 * when tasks reach terminal states, and that it's best-effort (never throws).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/lib/logger', () => ({
  createModuleLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { syncTriggerExecutionStatus } from '../../../src/services/trigger-execution-sync';

// ---------------------------------------------------------------------------
// D1 mock
// ---------------------------------------------------------------------------

function createMockDb(options: {
  triggerExecutionId?: string | null;
  prepareError?: Error;
  updateError?: Error;
} = {}) {
  const runFn = options.updateError
    ? vi.fn().mockRejectedValue(options.updateError)
    : vi.fn().mockResolvedValue({ meta: { changes: 1 } });

  const firstFn = options.prepareError
    ? vi.fn().mockRejectedValue(options.prepareError)
    : vi.fn().mockResolvedValue(
      options.triggerExecutionId !== undefined
        ? { trigger_execution_id: options.triggerExecutionId }
        : null,
    );

  const bindFn = vi.fn().mockReturnValue({ first: firstFn, run: runFn });

  const db = {
    prepare: vi.fn().mockReturnValue({ bind: bindFn }),
    _internal: { bindFn, firstFn, runFn },
  } as unknown as D1Database & { _internal: { bindFn: ReturnType<typeof vi.fn>; firstFn: ReturnType<typeof vi.fn>; runFn: ReturnType<typeof vi.fn> } };

  return db;
}

describe('syncTriggerExecutionStatus', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('syncs to completed when task has a trigger execution', async () => {
    const db = createMockDb({ triggerExecutionId: 'exec-123' });

    await syncTriggerExecutionStatus(db, 'task-1', 'completed');

    // Should have queried the task's trigger_execution_id
    expect(db.prepare).toHaveBeenCalledWith(
      'SELECT trigger_execution_id FROM tasks WHERE id = ?',
    );

    // Should have updated trigger_executions
    expect(db.prepare).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE trigger_executions SET status = ?'),
    );
  });

  it('syncs to failed with error message', async () => {
    const db = createMockDb({ triggerExecutionId: 'exec-456' });

    await syncTriggerExecutionStatus(db, 'task-2', 'failed', 'Agent crashed');

    // The bind for the UPDATE should include 'failed' status and error message
    const updateCall = db._internal.bindFn.mock.calls[1]; // second bind call is for UPDATE
    expect(updateCall[0]).toBe('failed');
    expect(updateCall[2]).toBe('Agent crashed');
    expect(updateCall[3]).toBe('exec-456');
  });

  it('maps cancelled to failed exec status', async () => {
    const db = createMockDb({ triggerExecutionId: 'exec-789' });

    await syncTriggerExecutionStatus(db, 'task-3', 'cancelled');

    const updateCall = db._internal.bindFn.mock.calls[1];
    expect(updateCall[0]).toBe('failed'); // cancelled maps to 'failed'
  });

  it('does nothing when task has no trigger execution', async () => {
    const db = createMockDb({ triggerExecutionId: null });

    await syncTriggerExecutionStatus(db, 'task-4', 'completed');

    // Only one prepare call (the SELECT), no UPDATE
    expect(db.prepare).toHaveBeenCalledTimes(1);
  });

  it('does nothing when task is not found', async () => {
    const db = createMockDb();
    // firstFn returns null (task not found)
    db._internal.firstFn.mockResolvedValue(null);

    await syncTriggerExecutionStatus(db, 'missing-task', 'completed');

    expect(db.prepare).toHaveBeenCalledTimes(1);
  });

  it('does not throw when SELECT fails', async () => {
    const db = createMockDb({ prepareError: new Error('D1 read failed') });

    // Should not throw
    await expect(
      syncTriggerExecutionStatus(db, 'task-5', 'completed'),
    ).resolves.toBeUndefined();
  });

  it('does not throw when UPDATE fails', async () => {
    const db = createMockDb({
      triggerExecutionId: 'exec-err',
      updateError: new Error('D1 write failed'),
    });

    // Should not throw
    await expect(
      syncTriggerExecutionStatus(db, 'task-6', 'failed', 'some error'),
    ).resolves.toBeUndefined();
  });

  it('provides default error message for failed status without explicit message', async () => {
    const db = createMockDb({ triggerExecutionId: 'exec-default' });

    await syncTriggerExecutionStatus(db, 'task-7', 'failed');

    const updateCall = db._internal.bindFn.mock.calls[1];
    expect(updateCall[2]).toBe('Task failed'); // default error message
  });

  it('sets null error message for completed status', async () => {
    const db = createMockDb({ triggerExecutionId: 'exec-ok' });

    await syncTriggerExecutionStatus(db, 'task-8', 'completed');

    const updateCall = db._internal.bindFn.mock.calls[1];
    expect(updateCall[0]).toBe('completed');
    expect(updateCall[2]).toBeNull(); // no error message for completed
  });
});
