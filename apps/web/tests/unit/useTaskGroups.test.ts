import { describe, expect, it } from 'vitest';

import type { ChatSessionResponse } from '../../src/lib/api';
import {
  buildTaskInfoMap,
  groupHasMatchingChild,
  groupSessions,
  type TaskInfo,
} from '../../src/pages/project-chat/useTaskGroups';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSession(overrides: Partial<ChatSessionResponse> = {}): ChatSessionResponse {
  return {
    id: `session-${Math.random().toString(36).slice(2, 8)}`,
    workspaceId: null,
    taskId: null,
    topic: 'Test session',
    status: 'active',
    messageCount: 5,
    startedAt: Date.now(),
    endedAt: null,
    createdAt: Date.now(),
    ...overrides,
  };
}

function makeTaskInfo(overrides: Partial<TaskInfo> = {}): TaskInfo {
  return {
    id: `task-${Math.random().toString(36).slice(2, 8)}`,
    title: 'Test task',
    parentTaskId: null,
    status: 'in_progress',
    blocked: false,
    triggeredBy: 'user',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('buildTaskInfoMap', () => {
  it('builds a map from task id to TaskInfo', () => {
    const tasks = [
      { id: 't1', title: 'Task 1', parentTaskId: null, status: 'in_progress' as const, blocked: false },
      { id: 't2', title: 'Task 2', parentTaskId: 't1', status: 'completed' as const, blocked: false },
    ];
    // buildTaskInfoMap expects Task objects; we pass minimal objects with required fields
    const map = buildTaskInfoMap(tasks as never[]);
    expect(map.size).toBe(2);
    expect(map.get('t1')!.parentTaskId).toBeNull();
    expect(map.get('t2')!.parentTaskId).toBe('t1');
  });
});

describe('groupSessions', () => {
  it('returns standalone items for sessions without task relationships', () => {
    const sessions = [
      makeSession({ id: 's1', taskId: null }),
      makeSession({ id: 's2', taskId: 't1' }),
    ];
    const taskInfoMap = new Map<string, TaskInfo>();
    taskInfoMap.set('t1', makeTaskInfo({ id: 't1', parentTaskId: null }));

    const items = groupSessions(sessions, taskInfoMap);
    expect(items).toHaveLength(2);
    expect(items[0]!.type).toBe('standalone');
    expect(items[1]!.type).toBe('standalone');
  });

  it('groups parent + child sessions together', () => {
    const parentTask = makeTaskInfo({ id: 'tParent', parentTaskId: null, status: 'in_progress' });
    const childTask1 = makeTaskInfo({ id: 'tChild1', parentTaskId: 'tParent', status: 'completed' });
    const childTask2 = makeTaskInfo({ id: 'tChild2', parentTaskId: 'tParent', status: 'in_progress' });

    const taskInfoMap = new Map<string, TaskInfo>([
      ['tParent', parentTask],
      ['tChild1', childTask1],
      ['tChild2', childTask2],
    ]);

    const sessions = [
      makeSession({ id: 'sParent', taskId: 'tParent' }),
      makeSession({ id: 'sChild1', taskId: 'tChild1' }),
      makeSession({ id: 'sChild2', taskId: 'tChild2' }),
    ];

    const items = groupSessions(sessions, taskInfoMap);
    expect(items).toHaveLength(1);
    expect(items[0]!.type).toBe('group');

    const group = items[0]!;
    if (group.type !== 'group') throw new Error('Expected group');
    expect(group.group.parent.id).toBe('sParent');
    expect(group.group.children).toHaveLength(2);
    expect(group.group.completedChildren).toBe(1);
    expect(group.group.totalChildren).toBe(2);
  });

  it('treats orphan children (parent not in session list) as standalone', () => {
    const childTask = makeTaskInfo({ id: 'tChild', parentTaskId: 'tMissing', status: 'in_progress' });
    const taskInfoMap = new Map<string, TaskInfo>([['tChild', childTask]]);

    const sessions = [makeSession({ id: 'sChild', taskId: 'tChild' })];
    const items = groupSessions(sessions, taskInfoMap);
    expect(items).toHaveLength(1);
    expect(items[0]!.type).toBe('standalone');
  });

  it('preserves ordering — group appears at parent position', () => {
    const parentTask = makeTaskInfo({ id: 'tP', parentTaskId: null });
    const childTask = makeTaskInfo({ id: 'tC', parentTaskId: 'tP', status: 'in_progress' });
    const standaloneTask = makeTaskInfo({ id: 'tS', parentTaskId: null });

    const taskInfoMap = new Map<string, TaskInfo>([
      ['tP', parentTask], ['tC', childTask], ['tS', standaloneTask],
    ]);

    const sessions = [
      makeSession({ id: 's1', taskId: 'tS' }),   // standalone first
      makeSession({ id: 's2', taskId: 'tP' }),    // parent second
      makeSession({ id: 's3', taskId: 'tC' }),    // child third (should be grouped with parent)
    ];

    const items = groupSessions(sessions, taskInfoMap);
    expect(items).toHaveLength(2);
    expect(items[0]!.type).toBe('standalone');
    expect(items[1]!.type).toBe('group');
  });

  it('mixes sessions with no taskId correctly', () => {
    const parentTask = makeTaskInfo({ id: 'tP', parentTaskId: null });
    const childTask = makeTaskInfo({ id: 'tC', parentTaskId: 'tP', status: 'completed' });

    const taskInfoMap = new Map<string, TaskInfo>([
      ['tP', parentTask], ['tC', childTask],
    ]);

    const sessions = [
      makeSession({ id: 'sNoTask', taskId: null }),
      makeSession({ id: 'sParent', taskId: 'tP' }),
      makeSession({ id: 'sChild', taskId: 'tC' }),
      makeSession({ id: 'sNoTask2', taskId: null }),
    ];

    const items = groupSessions(sessions, taskInfoMap);
    expect(items).toHaveLength(3); // standalone, group, standalone
    expect(items[0]!.type).toBe('standalone');
    expect(items[1]!.type).toBe('group');
    expect(items[2]!.type).toBe('standalone');
  });
});

describe('groupHasMatchingChild', () => {
  it('returns true when a child topic matches the query', () => {
    const parentTask = makeTaskInfo({ id: 'tP' });
    const childTask = makeTaskInfo({ id: 'tC', parentTaskId: 'tP', title: 'Fix bug' });

    const taskInfoMap = new Map<string, TaskInfo>([
      ['tP', parentTask], ['tC', childTask],
    ]);

    const group = {
      parent: makeSession({ id: 'sP', taskId: 'tP' }),
      children: [makeSession({ id: 'sC', taskId: 'tC', topic: 'Fix the login bug' })],
      completedChildren: 0,
      totalChildren: 1,
    };

    expect(groupHasMatchingChild(group, 'login', taskInfoMap)).toBe(true);
    expect(groupHasMatchingChild(group, 'xyz', taskInfoMap)).toBe(false);
  });

  it('matches on task title too', () => {
    const childTask = makeTaskInfo({ id: 'tC', title: 'Refactor auth module' });
    const taskInfoMap = new Map<string, TaskInfo>([['tC', childTask]]);

    const group = {
      parent: makeSession({ id: 'sP', taskId: 'tP' }),
      children: [makeSession({ id: 'sC', taskId: 'tC', topic: 'Some chat' })],
      completedChildren: 0,
      totalChildren: 1,
    };

    expect(groupHasMatchingChild(group, 'auth', taskInfoMap)).toBe(true);
  });
});
