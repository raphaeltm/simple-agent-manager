import { describe, expect, it } from 'vitest';

import type { ChatSessionResponse } from '../../src/lib/api';
import { getLineageText, getSessionSourceContext, isRetryOrFork } from '../../src/pages/project-chat/lineageUtils';
import type { TaskInfo } from '../../src/pages/project-chat/useTaskGroups';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSession(overrides: Partial<ChatSessionResponse> = {}): ChatSessionResponse {
  return {
    id: overrides.id ?? `session-${Math.random().toString(36).slice(2, 8)}`,
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
    id: overrides.id ?? `task-${Math.random().toString(36).slice(2, 8)}`,
    title: 'Test task',
    parentTaskId: null,
    status: 'in_progress',
    blocked: false,
    triggeredBy: 'mcp',
    dispatchDepth: 0,
    taskMode: 'task',
    ...overrides,
  };
}

function makeRetryFixture(
  children: Array<{ taskId: string; sessionId: string; startedAt: number }>,
): { tasks: Map<string, TaskInfo>; sessions: ChatSessionResponse[] } {
  return {
    tasks: new Map<string, TaskInfo>([
      ['tP', makeTaskInfo({ id: 'tP', parentTaskId: null, triggeredBy: 'user' })],
      ...children.map(({ taskId }) => [
        taskId,
        makeTaskInfo({ id: taskId, parentTaskId: 'tP', triggeredBy: 'user' }),
      ] as const),
    ]),
    sessions: [
      makeSession({ id: 'sP', taskId: 'tP', topic: 'Original', startedAt: 1000 }),
      ...children.map(({ sessionId, taskId, startedAt }) =>
        makeSession({ id: sessionId, taskId, startedAt }),
      ),
    ],
  };
}

// ---------------------------------------------------------------------------
// isRetryOrFork — classification logic
// ---------------------------------------------------------------------------

describe('isRetryOrFork — classification logic', () => {
  it('treats triggeredBy=mcp as subtask (not retry/fork)', () => {
    expect(isRetryOrFork(makeTaskInfo({ triggeredBy: 'mcp', dispatchDepth: 1 }))).toBe(false);
  });

  it('treats triggeredBy=user with dispatchDepth=0 as retry/fork', () => {
    expect(isRetryOrFork(makeTaskInfo({ triggeredBy: 'user', dispatchDepth: 0 }))).toBe(true);
  });

  it('treats triggeredBy=user with dispatchDepth>0 as subtask (fallback for legacy data)', () => {
    expect(isRetryOrFork(makeTaskInfo({ triggeredBy: 'user', dispatchDepth: 1 }))).toBe(false);
  });

  it('treats triggeredBy=cron as retry/fork when dispatchDepth=0', () => {
    expect(isRetryOrFork(makeTaskInfo({ triggeredBy: 'cron', dispatchDepth: 0 }))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// getSessionSourceContext — lineage metadata for header display
// ---------------------------------------------------------------------------

describe('getSessionSourceContext', () => {
  it('builds source context for user-triggered derived sessions', () => {
    const { tasks, sessions } = makeRetryFixture([
      { taskId: 'tF', sessionId: 'sF', startedAt: 2000 },
    ]);

    const context = getSessionSourceContext('tF', tasks, sessions);

    expect(context).toEqual({
      lineageText: '⑂ from Original',
      parentTaskId: 'tP',
      parentSessionId: 'sP',
      parentTitle: 'Original',
    });
  });

  it('does not build source context for agent-dispatched subtasks', () => {
    const tasks = new Map<string, TaskInfo>([
      ['tP', makeTaskInfo({ id: 'tP', parentTaskId: null, triggeredBy: 'user' })],
      ['tC', makeTaskInfo({ id: 'tC', parentTaskId: 'tP', triggeredBy: 'mcp', dispatchDepth: 1 })],
    ]);
    const sessions = [
      makeSession({ id: 'sP', taskId: 'tP', topic: 'Parent' }),
      makeSession({ id: 'sC', taskId: 'tC', topic: 'Child' }),
    ];

    expect(getSessionSourceContext('tC', tasks, sessions)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// getLineageText — retry/fork subtitle text
// ---------------------------------------------------------------------------

describe('getLineageText', () => {
  it('shows fork lineage text for a single derived session', () => {
    const { tasks, sessions } = makeRetryFixture([
      { taskId: 'tF', sessionId: 'sF', startedAt: 2000 },
    ]);

    expect(getLineageText('tF', tasks, sessions)).toContain('⑂');
  });

  it('assigns attempt numbers for multiple retries', () => {
    const { tasks, sessions } = makeRetryFixture([
      { taskId: 'tR1', sessionId: 'sR1', startedAt: 2000 },
      { taskId: 'tR2', sessionId: 'sR2', startedAt: 3000 },
    ]);

    expect(getLineageText('tR1', tasks, sessions)).toBe('↩ attempt 2');
    expect(getLineageText('tR2', tasks, sessions)).toBe('↩ attempt 3');
  });

  it('returns undefined for agent-dispatched subtasks', () => {
    const tasks = new Map<string, TaskInfo>([
      ['tP', makeTaskInfo({ id: 'tP', parentTaskId: null, triggeredBy: 'user' })],
      ['tC', makeTaskInfo({ id: 'tC', parentTaskId: 'tP', triggeredBy: 'mcp', dispatchDepth: 1 })],
    ]);
    const sessions = [
      makeSession({ id: 'sP', taskId: 'tP' }),
      makeSession({ id: 'sC', taskId: 'tC' }),
    ];

    expect(getLineageText('tC', tasks, sessions)).toBeUndefined();
  });

  it('returns undefined for standalone tasks', () => {
    const tasks = new Map<string, TaskInfo>([
      ['solo', makeTaskInfo({ id: 'solo', parentTaskId: null })],
    ]);
    const sessions = [makeSession({ id: 's1', taskId: 'solo' })];

    expect(getLineageText('solo', tasks, sessions)).toBeUndefined();
  });
});
