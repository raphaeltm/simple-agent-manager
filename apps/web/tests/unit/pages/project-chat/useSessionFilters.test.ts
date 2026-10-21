import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { ChatSessionListItem } from '../../../../src/lib/api';
import { useSessionFilters } from '../../../../src/pages/project-chat/useSessionFilters';
import type { TaskInfo } from '../../../../src/pages/project-chat/useTaskGroups';

const NOW = Date.now();
const DAY = 24 * 60 * 60 * 1000;

function session(overrides: Partial<ChatSessionListItem> & { id: string }): ChatSessionListItem {
  return {
    workspaceId: null,
    topic: null,
    status: 'active',
    messageCount: 1,
    startedAt: NOW - 60_000,
    endedAt: null,
    createdAt: NOW - 60_000,
    lastMessageAt: NOW - 60_000,
    ...overrides,
  } as ChatSessionListItem;
}

function taskInfo(overrides: Partial<TaskInfo> & { id: string }): TaskInfo {
  return {
    title: 'Task',
    parentTaskId: null,
    status: 'completed',
    blocked: false,
    triggeredBy: 'user',
    dispatchDepth: 0,
    taskMode: 'conversation',
    ...overrides,
  } as TaskInfo;
}

const SESSIONS = [
  session({ id: 'live', topic: '**Fix** the payouts webhook' }),
  session({ id: 'old', topic: 'Ledger migration', lastMessageAt: NOW - 3 * DAY }),
  // Asleep for days, but still Recent: waking it is the same-chat gesture.
  session({
    id: 'sleeping',
    topic: 'Sleeping chat',
    status: 'sleeping',
    lastMessageAt: NOW - 3 * DAY,
  }),
  // A stopped fork collapses into Older even though it is fresh.
  session({ id: 'fork', topic: 'Forked chat', status: 'stopped', taskId: 'task-fork' }),
  // A stopped agent-dispatched child is not a retry/fork, so it stays Recent.
  session({ id: 'child', topic: 'Subtask', status: 'stopped', taskId: 'task-child' }),
  session({
    id: 'shared',
    topic: 'Pairing session',
    createdBy: { id: 'u2', name: 'Ada Lovelace', email: 'ada@example.com' },
  } as Partial<ChatSessionListItem> & { id: string }),
];

const TASK_INFO = new Map<string, TaskInfo>([
  ['task-fork', taskInfo({ id: 'task-fork', parentTaskId: 'task-parent' })],
  [
    'task-child',
    taskInfo({
      id: 'task-child',
      parentTaskId: 'task-parent',
      triggeredBy: 'mcp',
      dispatchDepth: 1,
    }),
  ],
]);

const ids = (items: ChatSessionListItem[]) => items.map((item) => item.id);

describe('useSessionFilters', () => {
  it('splits Recent and Older without a search', () => {
    const { result } = renderHook(() => useSessionFilters(SESSIONS, TASK_INFO, '', false));

    expect(ids(result.current.filteredRecent)).toEqual(['live', 'sleeping', 'child', 'shared']);
    expect(ids(result.current.filteredStale)).toEqual(['old', 'fork']);
    expect(result.current.effectiveShowStale).toBe(false);
  });

  it('searches the plain-text topic, the id and the creator, and opens Older', () => {
    const search = (query: string) =>
      renderHook(() => useSessionFilters(SESSIONS, TASK_INFO, query, false)).result.current;

    // Markdown is stripped before matching, so "fix the" spans the bold marker.
    expect(ids(search('fix the').filteredRecent)).toEqual(['live']);
    expect(ids(search('ledger').filteredStale)).toEqual(['old']);
    expect(ids(search('ledger').filteredRecent)).toEqual([]);
    expect(ids(search('fork').filteredStale)).toEqual(['fork']);
    expect(ids(search('ada lovelace').filteredRecent)).toEqual(['shared']);
    expect(ids(search('ADA@EXAMPLE').filteredRecent)).toEqual(['shared']);
    expect(search('ledger').effectiveShowStale).toBe(true);
  });
});
