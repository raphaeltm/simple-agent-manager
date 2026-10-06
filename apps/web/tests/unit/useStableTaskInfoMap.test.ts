import type { Task, TaskStatus } from '@simple-agent-manager/shared';
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { useStableTaskInfoMap } from '../../src/pages/project-chat/useStableTaskInfoMap';

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    projectId: 'proj-1',
    title: 'Test task',
    description: 'A test task',
    status: 'in_progress' as TaskStatus,
    parentTaskId: null,
    blocked: false,
    triggeredBy: 'user',
    dispatchDepth: 0,
    taskMode: 'task',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  } as Task;
}

describe('useStableTaskInfoMap', () => {
  it('starts with an empty map', () => {
    const { result } = renderHook(() => useStableTaskInfoMap());
    expect(result.current.taskInfoMap.size).toBe(0);
  });

  describe('replaceAll', () => {
    it('builds a map from tasks', () => {
      const { result } = renderHook(() => useStableTaskInfoMap());
      act(() => {
        result.current.replaceAll([
          makeTask({ id: 'task-1', title: 'Task One' }),
          makeTask({ id: 'task-2', title: 'Task Two' }),
        ]);
      });
      expect(result.current.taskInfoMap.size).toBe(2);
      expect(result.current.taskInfoMap.get('task-1')?.title).toBe('Task One');
      expect(result.current.taskInfoMap.get('task-2')?.title).toBe('Task Two');
    });

    it('preserves map reference when rebuilt with identical data', () => {
      const { result } = renderHook(() => useStableTaskInfoMap());
      const tasks = [
        makeTask({ id: 'task-1', title: 'Task One' }),
        makeTask({ id: 'task-2', title: 'Task Two' }),
      ];

      act(() => { result.current.replaceAll(tasks); });
      const firstMap = result.current.taskInfoMap;

      act(() => { result.current.replaceAll(tasks); });
      const secondMap = result.current.taskInfoMap;

      expect(secondMap).toBe(firstMap); // same reference — no re-render triggered
    });

    it('updates map reference when data changes', () => {
      const { result } = renderHook(() => useStableTaskInfoMap());
      act(() => {
        result.current.replaceAll([makeTask({ id: 'task-1', title: 'V1' })]);
      });
      const firstMap = result.current.taskInfoMap;

      act(() => {
        result.current.replaceAll([makeTask({ id: 'task-1', title: 'V2' })]);
      });
      const secondMap = result.current.taskInfoMap;

      expect(secondMap).not.toBe(firstMap);
      expect(secondMap.get('task-1')?.title).toBe('V2');
    });

    it('updates map reference when task count changes', () => {
      const { result } = renderHook(() => useStableTaskInfoMap());
      act(() => {
        result.current.replaceAll([makeTask({ id: 'task-1' })]);
      });
      const firstMap = result.current.taskInfoMap;

      act(() => {
        result.current.replaceAll([
          makeTask({ id: 'task-1' }),
          makeTask({ id: 'task-2', title: 'New' }),
        ]);
      });
      const secondMap = result.current.taskInfoMap;

      expect(secondMap).not.toBe(firstMap);
      expect(secondMap.size).toBe(2);
    });
  });
});
