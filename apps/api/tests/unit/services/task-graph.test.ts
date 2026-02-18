import { describe, expect, it } from 'vitest';
import { getBlockedTaskIds, isTaskBlocked, wouldCreateTaskDependencyCycle } from '../../../src/services/task-graph';

describe('task-graph service', () => {
  it('rejects self-edge dependencies as cycles', () => {
    expect(
      wouldCreateTaskDependencyCycle('task-a', 'task-a', [])
    ).toBe(true);
  });

  it('detects cycle creation in an existing graph', () => {
    const edges = [
      { taskId: 'task-b', dependsOnTaskId: 'task-a' },
      { taskId: 'task-c', dependsOnTaskId: 'task-b' },
    ];

    expect(wouldCreateTaskDependencyCycle('task-a', 'task-c', edges)).toBe(true);
    expect(wouldCreateTaskDependencyCycle('task-c', 'task-a', edges)).toBe(false);
  });

  it('marks a task blocked when prerequisite is not completed', () => {
    const edges = [{ taskId: 'task-b', dependsOnTaskId: 'task-a' }];
    expect(
      isTaskBlocked('task-b', edges, { 'task-a': 'ready' })
    ).toBe(true);
    expect(
      isTaskBlocked('task-b', edges, { 'task-a': 'completed' })
    ).toBe(false);
  });

  it('computes blocked task set for multiple tasks', () => {
    const edges = [
      { taskId: 'task-b', dependsOnTaskId: 'task-a' },
      { taskId: 'task-c', dependsOnTaskId: 'task-b' },
    ];

    const blocked = getBlockedTaskIds(
      ['task-a', 'task-b', 'task-c'],
      edges,
      {
        'task-a': 'completed',
        'task-b': 'in_progress',
      }
    );

    expect(blocked.has('task-a')).toBe(false);
    expect(blocked.has('task-b')).toBe(false);
    expect(blocked.has('task-c')).toBe(true);
  });
});
