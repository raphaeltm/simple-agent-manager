import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { ChatSessionResponse } from '../../src/lib/api';
import { SessionItem } from '../../src/pages/project-chat/SessionItem';
import { SubTaskProgressBar } from '../../src/pages/project-chat/SubTaskProgressBar';
import { TaskGroup } from '../../src/pages/project-chat/TaskGroup';
import type { SessionGroup, TaskInfo } from '../../src/pages/project-chat/useTaskGroups';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSession(overrides: Partial<ChatSessionResponse> = {}): ChatSessionResponse {
  return {
    id: `s-${Math.random().toString(36).slice(2, 8)}`,
    workspaceId: null,
    taskId: null,
    topic: 'Test session topic',
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
    id: 'task-1',
    title: 'Test task',
    parentTaskId: null,
    status: 'in_progress',
    blocked: false,
    ...overrides,
  };
}

function makeGroup(overrides: Partial<SessionGroup> = {}): SessionGroup {
  return {
    parent: makeSession({ id: 'sParent', taskId: 'tParent', topic: 'Parent task' }),
    children: [
      makeSession({ id: 'sChild1', taskId: 'tChild1', topic: 'Child task 1' }),
      makeSession({ id: 'sChild2', taskId: 'tChild2', topic: 'Child task 2' }),
    ],
    completedChildren: 1,
    totalChildren: 2,
    ...overrides,
  };
}

function makeTaskInfoMap(): Map<string, TaskInfo> {
  return new Map<string, TaskInfo>([
    ['tParent', makeTaskInfo({ id: 'tParent', title: 'Parent task' })],
    ['tChild1', makeTaskInfo({ id: 'tChild1', title: 'Child task 1', parentTaskId: 'tParent', status: 'completed' })],
    ['tChild2', makeTaskInfo({ id: 'tChild2', title: 'Child task 2', parentTaskId: 'tParent', status: 'in_progress' })],
  ]);
}

// ---------------------------------------------------------------------------
// SubTaskProgressBar
// ---------------------------------------------------------------------------

describe('SubTaskProgressBar', () => {
  it('renders the completed/total label', () => {
    render(<SubTaskProgressBar completed={2} total={5} />);
    expect(screen.getByText('2/5')).toBeDefined();
  });

  it('renders 0/3 label', () => {
    render(<SubTaskProgressBar completed={0} total={3} />);
    expect(screen.getByText('0/3')).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// SessionItem variants
// ---------------------------------------------------------------------------

describe('SessionItem', () => {
  it('renders a BLOCKED badge when blockedBadge is true', () => {
    render(
      <SessionItem
        session={makeSession({ topic: 'Blocked task' })}
        isSelected={false}
        onSelect={vi.fn()}
        blockedBadge={true}
        blockedByTitle="Parent task"
      />,
    );
    expect(screen.getByText('BLOCKED')).toBeDefined();
    expect(screen.getByText(/Waiting on: Parent task/)).toBeDefined();
  });

  it('does not render BLOCKED badge when blockedBadge is false', () => {
    render(
      <SessionItem
        session={makeSession({ topic: 'Normal task' })}
        isSelected={false}
        onSelect={vi.fn()}
      />,
    );
    expect(screen.queryByText('BLOCKED')).toBeNull();
  });

  it('renders badge ReactNode when provided', () => {
    render(
      <SessionItem
        session={makeSession({ topic: 'Parent' })}
        isSelected={false}
        onSelect={vi.fn()}
        badge={<span data-testid="sub-badge">3 SUB</span>}
      />,
    );
    expect(screen.getByTestId('sub-badge')).toBeDefined();
    expect(screen.getByText('3 SUB')).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// TaskGroup
// ---------------------------------------------------------------------------

describe('TaskGroup', () => {
  it('renders collapsed by default — shows "Show N sub-tasks" label', () => {
    const group = makeGroup();
    const taskInfoMap = makeTaskInfoMap();

    render(
      <TaskGroup
        group={group}
        selectedSessionId={null}
        onSelect={vi.fn()}
        taskInfoMap={taskInfoMap}
      />,
    );

    // Parent should be visible (may appear in both title and idea tag)
    expect(screen.getAllByText('Parent task').length).toBeGreaterThan(0);
    // Expand bar should show "Show 2 sub-tasks"
    expect(screen.getByText('Show 2 sub-tasks')).toBeDefined();
    // Children should NOT be visible
    expect(screen.queryByText('Child task 1')).toBeNull();
    expect(screen.queryByText('Child task 2')).toBeNull();
  });

  it('expands when expand bar is clicked — shows children and "Hide sub-tasks"', () => {
    const group = makeGroup();
    const taskInfoMap = makeTaskInfoMap();
    const onSelect = vi.fn();

    render(
      <TaskGroup
        group={group}
        selectedSessionId={null}
        onSelect={onSelect}
        taskInfoMap={taskInfoMap}
      />,
    );

    // Click the expand bar
    fireEvent.click(screen.getByText('Show 2 sub-tasks'));

    // Children should now be visible
    expect(screen.getByText('Child task 1')).toBeDefined();
    expect(screen.getByText('Child task 2')).toBeDefined();
    // Label should change
    expect(screen.getByText('Hide sub-tasks')).toBeDefined();
    // onSelect should NOT have been called (expand bar doesn't select)
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('renders expanded when defaultExpanded is true', () => {
    const group = makeGroup();
    const taskInfoMap = makeTaskInfoMap();

    render(
      <TaskGroup
        group={group}
        selectedSessionId={null}
        onSelect={vi.fn()}
        taskInfoMap={taskInfoMap}
        defaultExpanded={true}
      />,
    );

    // Children should be visible
    expect(screen.getByText('Child task 1')).toBeDefined();
    expect(screen.getByText('Child task 2')).toBeDefined();
    expect(screen.getByText('Hide sub-tasks')).toBeDefined();
  });

  it('renders progress bar with correct count', () => {
    const group = makeGroup({ completedChildren: 1, totalChildren: 2 });
    const taskInfoMap = makeTaskInfoMap();

    render(
      <TaskGroup
        group={group}
        selectedSessionId={null}
        onSelect={vi.fn()}
        taskInfoMap={taskInfoMap}
      />,
    );

    expect(screen.getByText('1/2')).toBeDefined();
  });

  it('renders "N SUB" badge on parent', () => {
    const group = makeGroup({ totalChildren: 3 });
    const taskInfoMap = makeTaskInfoMap();

    render(
      <TaskGroup
        group={group}
        selectedSessionId={null}
        onSelect={vi.fn()}
        taskInfoMap={taskInfoMap}
      />,
    );

    expect(screen.getByText('3 SUB')).toBeDefined();
  });

  it('calls onSelect with child id when a child is clicked', () => {
    const group = makeGroup();
    const taskInfoMap = makeTaskInfoMap();
    const onSelect = vi.fn();

    render(
      <TaskGroup
        group={group}
        selectedSessionId={null}
        onSelect={onSelect}
        taskInfoMap={taskInfoMap}
        defaultExpanded={true}
      />,
    );

    // Click the first child
    fireEvent.click(screen.getByText('Child task 1'));
    expect(onSelect).toHaveBeenCalledWith('sChild1');
  });

  it('shows BLOCKED badge on blocked children', () => {
    const blockedChildInfo = makeTaskInfo({
      id: 'tChild1',
      title: 'Child task 1',
      parentTaskId: 'tParent',
      status: 'in_progress',
      blocked: true,
    });

    const taskInfoMap = new Map<string, TaskInfo>([
      ['tParent', makeTaskInfo({ id: 'tParent', title: 'Parent task' })],
      ['tChild1', blockedChildInfo],
      ['tChild2', makeTaskInfo({ id: 'tChild2', title: 'Child task 2', parentTaskId: 'tParent' })],
    ]);

    const group = makeGroup();

    render(
      <TaskGroup
        group={group}
        selectedSessionId={null}
        onSelect={vi.fn()}
        taskInfoMap={taskInfoMap}
        defaultExpanded={true}
      />,
    );

    expect(screen.getByText('BLOCKED')).toBeDefined();
  });

  it('renders singular "sub-task" for single child', () => {
    const group = makeGroup({
      children: [makeSession({ id: 'sChild1', taskId: 'tChild1', topic: 'Only child' })],
      totalChildren: 1,
      completedChildren: 0,
    });
    const taskInfoMap = makeTaskInfoMap();

    render(
      <TaskGroup
        group={group}
        selectedSessionId={null}
        onSelect={vi.fn()}
        taskInfoMap={taskInfoMap}
      />,
    );

    expect(screen.getByText('Show 1 sub-task')).toBeDefined();
  });
});
