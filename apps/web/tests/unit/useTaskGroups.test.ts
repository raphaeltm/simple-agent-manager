import { describe, expect, it } from 'vitest';

import { buildTaskInfoMap } from '../../src/pages/project-chat/useTaskGroups';

describe('buildTaskInfoMap', () => {
  it('builds a map from task id to TaskInfo', () => {
    const tasks = [
      { id: 't1', title: 'Task 1', parentTaskId: null, status: 'in_progress' as const, blocked: false },
      { id: 't2', title: 'Task 2', parentTaskId: 't1', status: 'completed' as const, blocked: false },
    ];
    const map = buildTaskInfoMap(tasks as never[]);
    expect(map.size).toBe(2);
    expect(map.get('t1')!.parentTaskId).toBeNull();
    expect(map.get('t2')!.parentTaskId).toBe('t1');
  });

  it('defaults blocked to false and triggeredBy to "user" when missing', () => {
    const tasks = [
      { id: 't1', title: 'Task 1', parentTaskId: null, status: 'in_progress' as const },
    ];
    const map = buildTaskInfoMap(tasks as never[]);
    expect(map.get('t1')!.blocked).toBe(false);
    expect(map.get('t1')!.triggeredBy).toBe('user');
  });
});
