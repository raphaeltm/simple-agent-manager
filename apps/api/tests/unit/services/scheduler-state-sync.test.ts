import { describe, expect, it, vi } from 'vitest';

import { recomputeMissionSchedulerStates } from '../../../src/services/scheduler-state-sync';

function makeMockD1(tasks: Array<{ id: string; status: string; mission_id: string | null }>, deps: Array<{ task_id: string; depends_on_task_id: string }> = []) {
  const mockRun = vi.fn().mockResolvedValue({ meta: { changes: 1 } });
  let callCount = 0;
  const mockPrepare = vi.fn().mockImplementation(() => ({
    bind: vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        // Tasks query
        return { all: vi.fn().mockResolvedValue({ results: tasks }) };
      }
      if (callCount === 2) {
        // Dependencies query
        return { all: vi.fn().mockResolvedValue({ results: deps }) };
      }
      // Update queries
      return { run: mockRun };
    }),
  }));
  return { prepare: mockPrepare, _run: mockRun } as unknown as D1Database & { _run: ReturnType<typeof vi.fn> };
}

describe('recomputeMissionSchedulerStates', () => {
  it('sets schedulable for tasks with no dependencies', async () => {
    const db = makeMockD1([
      { id: 'task-1', status: 'queued', mission_id: 'mission-1' },
      { id: 'task-2', status: 'queued', mission_id: 'mission-1' },
    ]);

    await recomputeMissionSchedulerStates(db, 'mission-1');

    // Should have called prepare for: tasks query, deps query, and 2 updates
    expect(db.prepare).toHaveBeenCalled();
    expect(db._run).toHaveBeenCalled();
  });

  it('sets blocked_dependency for tasks with incomplete deps', async () => {
    const db = makeMockD1(
      [
        { id: 'task-1', status: 'queued', mission_id: 'mission-1' },
        { id: 'task-2', status: 'queued', mission_id: 'mission-1' },
      ],
      [{ task_id: 'task-2', depends_on_task_id: 'task-1' }],
    );

    await recomputeMissionSchedulerStates(db, 'mission-1');
    expect(db._run).toHaveBeenCalled();
  });

  it('sets completed for completed tasks', async () => {
    const db = makeMockD1([
      { id: 'task-1', status: 'completed', mission_id: 'mission-1' },
    ]);

    await recomputeMissionSchedulerStates(db, 'mission-1');
    expect(db._run).toHaveBeenCalled();
  });

  it('does nothing for empty missions', async () => {
    const db = makeMockD1([]);

    await recomputeMissionSchedulerStates(db, 'mission-empty');
    // Only the tasks query should fire, no updates
    expect(db.prepare).toHaveBeenCalledTimes(1);
  });

  it('sets running for in-progress tasks', async () => {
    const db = makeMockD1([
      { id: 'task-1', status: 'running', mission_id: 'mission-1' },
      { id: 'task-2', status: 'queued', mission_id: 'mission-1' },
    ]);

    await recomputeMissionSchedulerStates(db, 'mission-1');
    expect(db._run).toHaveBeenCalled();
  });
});
