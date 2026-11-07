import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { ChatSessionListItem } from '../../../../src/lib/api';
import {
  groupSessionsBySection,
  useSessionSections,
} from '../../../../src/pages/project-chat/useSessionSections';
import type { TaskInfo } from '../../../../src/pages/project-chat/useTaskGroups';

const NOW = Date.now();
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

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
    status: 'in_progress',
    blocked: false,
    triggeredBy: 'user',
    dispatchDepth: 0,
    taskMode: 'conversation',
    ...overrides,
  } as TaskInfo;
}

function marker(kind: string) {
  return {
    markerId: `m-${kind}`,
    kind,
    createdAt: NOW,
    expiresAt: null,
    reason: null,
    options: [],
  };
}

const SESSIONS = [
  session({ id: 'live', topic: '**Fix** the payouts webhook' }),
  // The production case: awake for hours with nothing said. It stays in Awake.
  session({ id: 'quiet-awake', topic: 'UI sandbox', lastMessageAt: NOW - 6 * HOUR }),
  session({ id: 'idle', topic: 'Idle chat', isIdle: true, agentCompletedAt: NOW - HOUR }),
  session({
    id: 'sleeping',
    topic: 'Sleeping chat',
    status: 'sleeping',
    lastMessageAt: NOW - 3 * DAY,
  }),
  // The other production case: asleep, but its wake failed — a person must act.
  session({
    id: 'wake-failed',
    topic: 'Restore preview',
    status: 'sleeping',
    lastMessageAt: NOW - 2 * DAY,
    attention: marker('wake_failed'),
  }),
  session({ id: 'asks', topic: 'Needs an answer', attention: marker('needs_input') }),
  session({ id: 'stopped', topic: 'Ledger migration', status: 'stopped' }),
  // Still `active` on the session, but its task is done: the task outcome wins.
  session({ id: 'task-done', topic: 'Finished task', taskId: 'task-done' }),
  // A stopped session keeps no attention claim; nobody can act on it.
  session({ id: 'stale-ask', status: 'stopped', attention: marker('needs_input') }),
  session({
    id: 'shared',
    topic: 'Pairing session',
    lastMessageAt: NOW - 2 * 60_000,
    createdBy: { id: 'u2', name: 'Ada Lovelace', email: 'ada@example.com' },
  } as Partial<ChatSessionListItem> & { id: string }),
];

const TASK_INFO = new Map<string, TaskInfo>([
  ['task-done', taskInfo({ id: 'task-done', status: 'completed' })],
]);

const ids = (items: ChatSessionListItem[]) => items.map((item) => item.id);

describe('groupSessionsBySection', () => {
  it('places sessions by state, never by message age', () => {
    const sections = groupSessionsBySection(SESSIONS, TASK_INFO);

    expect(ids(sections.attention)).toEqual(['asks', 'wake-failed']);
    expect(ids(sections.awake)).toEqual(['live', 'idle', 'shared', 'quiet-awake']);
    expect(ids(sections.sleeping)).toEqual(['sleeping']);
    expect(ids(sections.history)).toEqual(['task-done', 'stopped', 'stale-ask']);
  });

  it('orders each section by conversation recency, whatever order the rows arrive in', () => {
    // Live rows the server appends after the page arrive out of order.
    const sections = groupSessionsBySection([...SESSIONS].reverse(), TASK_INFO);
    expect(ids(sections.awake)).toEqual(['live', 'idle', 'shared', 'quiet-awake']);
  });

  it('uses the task outcome from the task list when the session row has none', () => {
    const withoutTask = groupSessionsBySection(SESSIONS, new Map());
    expect(ids(withoutTask.awake)).toContain('task-done');
    expect(ids(groupSessionsBySection(SESSIONS, TASK_INFO).history)).toContain('task-done');
  });
});

describe('useSessionSections', () => {
  it('searches the plain-text topic, the id and the creator across every section', () => {
    const search = (query: string) =>
      renderHook(() => useSessionSections(SESSIONS, TASK_INFO, query)).result.current;

    // Markdown is stripped before matching, so "fix the" spans the bold marker.
    expect(ids(search('fix the').sections.awake)).toEqual(['live']);
    expect(ids(search('ledger').sections.history)).toEqual(['stopped']);
    expect(ids(search('ledger').sections.awake)).toEqual([]);
    expect(ids(search('restore').sections.attention)).toEqual(['wake-failed']);
    expect(ids(search('ada lovelace').sections.awake)).toEqual(['shared']);
    expect(ids(search('ADA@EXAMPLE').sections.awake)).toEqual(['shared']);
    expect(search('ledger').isSearching).toBe(true);
    expect(search('  ').isSearching).toBe(false);
  });

  it('counts attention across the whole list, not just the search results', () => {
    const { result } = renderHook(() => useSessionSections(SESSIONS, TASK_INFO, 'ledger'));
    expect(result.current.sections.attention).toEqual([]);
    expect(result.current.attentionCount).toBe(2);
  });
});
