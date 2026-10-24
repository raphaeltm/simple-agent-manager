import { describe, expect, it } from 'vitest';

import {
  computeSchedulerStates,
  type DependencyEdge,
  type TaskForScheduling,
} from '../../../src/services/scheduler-state';

describe('computeSchedulerStates', () => {
  function makeTasks(overrides: Partial<TaskForScheduling>[]): TaskForScheduling[] {
    return overrides.map((o, i) => ({
      id: o.id ?? `task-${i}`,
      status: o.status ?? 'queued',
      missionId: o.missionId ?? 'mission-1',
    }));
  }

  it('marks completed tasks as completed', () => {
    const tasks = makeTasks([{ id: 't1', status: 'completed' }]);
    const result = computeSchedulerStates(tasks, []);
    expect(result.get('t1')).toBe('completed');
  });

  it('marks failed tasks as failed', () => {
    const tasks = makeTasks([{ id: 't1', status: 'failed' }]);
    const result = computeSchedulerStates(tasks, []);
    expect(result.get('t1')).toBe('failed');
  });

  it('marks cancelled tasks as cancelled', () => {
    const tasks = makeTasks([{ id: 't1', status: 'cancelled' }]);
    const result = computeSchedulerStates(tasks, []);
    expect(result.get('t1')).toBe('cancelled');
  });

  it('marks running tasks as running', () => {
    const tasks = makeTasks([{ id: 't1', status: 'running' }]);
    const result = computeSchedulerStates(tasks, []);
    expect(result.get('t1')).toBe('running');
  });

  it('marks delegated tasks as running', () => {
    const tasks = makeTasks([{ id: 't1', status: 'delegated' }]);
    const result = computeSchedulerStates(tasks, []);
    expect(result.get('t1')).toBe('running');
  });

  it('marks queued tasks with no dependencies as schedulable', () => {
    const tasks = makeTasks([{ id: 't1', status: 'queued' }]);
    const result = computeSchedulerStates(tasks, []);
    expect(result.get('t1')).toBe('schedulable');
  });

  it('marks tasks blocked by incomplete dependency as blocked_dependency', () => {
    const tasks = makeTasks([
      { id: 't1', status: 'running' },
      { id: 't2', status: 'queued' },
    ]);
    const deps: DependencyEdge[] = [{ taskId: 't2', dependsOnTaskId: 't1' }];
    const result = computeSchedulerStates(tasks, deps);
    expect(result.get('t2')).toBe('blocked_dependency');
  });

  it('marks tasks as schedulable when all dependencies are completed', () => {
    const tasks = makeTasks([
      { id: 't1', status: 'completed' },
      { id: 't2', status: 'queued' },
    ]);
    const deps: DependencyEdge[] = [{ taskId: 't2', dependsOnTaskId: 't1' }];
    const result = computeSchedulerStates(tasks, deps);
    expect(result.get('t2')).toBe('schedulable');
  });

  it('marks tasks blocked by failed dependency as blocked_dependency', () => {
    const tasks = makeTasks([
      { id: 't1', status: 'failed' },
      { id: 't2', status: 'queued' },
    ]);
    const deps: DependencyEdge[] = [{ taskId: 't2', dependsOnTaskId: 't1' }];
    const result = computeSchedulerStates(tasks, deps);
    expect(result.get('t2')).toBe('blocked_dependency');
  });

  it('handles diamond dependency graph correctly', () => {
    //    t1
    //   / \
    //  t2  t3
    //   \ /
    //    t4
    const tasks = makeTasks([
      { id: 't1', status: 'completed' },
      { id: 't2', status: 'completed' },
      { id: 't3', status: 'running' },
      { id: 't4', status: 'queued' },
    ]);
    const deps: DependencyEdge[] = [
      { taskId: 't2', dependsOnTaskId: 't1' },
      { taskId: 't3', dependsOnTaskId: 't1' },
      { taskId: 't4', dependsOnTaskId: 't2' },
      { taskId: 't4', dependsOnTaskId: 't3' },
    ];
    const result = computeSchedulerStates(tasks, deps);
    // t4 is blocked because t3 is still running
    expect(result.get('t4')).toBe('blocked_dependency');
    // t2 is completed, t3 is running
    expect(result.get('t2')).toBe('completed');
    expect(result.get('t3')).toBe('running');
  });

  it('handles tasks with no mission as schedulable', () => {
    const tasks: TaskForScheduling[] = [
      { id: 't1', status: 'queued', missionId: null },
    ];
    const result = computeSchedulerStates(tasks, []);
    expect(result.get('t1')).toBe('schedulable');
  });

  it('computes states for all tasks in a mission', () => {
    const tasks = makeTasks([
      { id: 't1', status: 'completed' },
      { id: 't2', status: 'running' },
      { id: 't3', status: 'queued' },
      { id: 't4', status: 'failed' },
    ]);
    const result = computeSchedulerStates(tasks, []);
    expect(result.size).toBe(4);
    expect(result.get('t1')).toBe('completed');
    expect(result.get('t2')).toBe('running');
    expect(result.get('t3')).toBe('schedulable');
    expect(result.get('t4')).toBe('failed');
  });
});
