import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { HierarchyModal } from '../../../../src/components/task-hierarchy/HierarchyModal';
import type { ChatSessionListItem } from '../../../../src/lib/api';
import type { TaskInfo } from '../../../../src/pages/project-chat/useTaskGroups';

function makeTaskInfo(overrides: Partial<TaskInfo> = {}): TaskInfo {
  return {
    id: 'task-1',
    title: 'Task',
    status: 'in_progress',
    parentTaskId: null,
    blocked: false,
    triggeredBy: 'user',
    dispatchDepth: 0,
    taskMode: 'task',
    ...overrides,
  };
}

function makeSession(overrides: Partial<ChatSessionListItem> = {}): ChatSessionListItem {
  return {
    id: 'sess-1',
    workspaceId: null,
    taskId: null,
    topic: 'Test session',
    status: 'active',
    messageCount: 3,
    startedAt: Date.now(),
    endedAt: null,
    createdAt: Date.now(),
    lastMessageAt: Date.now(),
    isIdle: false,
    agentCompletedAt: null,
    ...overrides,
  };
}

describe('HierarchyModal — filter always visible', () => {
  it('renders filter input even with fewer than 5 nodes', () => {
    const taskInfoMap = new Map<string, TaskInfo>([
      ['t1', makeTaskInfo({ id: 't1', parentTaskId: null })],
      ['t2', makeTaskInfo({ id: 't2', parentTaskId: 't1', triggeredBy: 'mcp', dispatchDepth: 1 })],
    ]);
    const sessions: ChatSessionListItem[] = [
      makeSession({ id: 's1', taskId: 't1' }),
      makeSession({ id: 's2', taskId: 't2' }),
    ];

    render(
      <HierarchyModal
        isOpen={true}
        onClose={vi.fn()}
        focusTaskId="t1"
        taskInfoMap={taskInfoMap}
        sessions={sessions}
        onNavigate={vi.fn()}
      />,
    );

    expect(screen.getByLabelText('Filter tasks')).toBeInTheDocument();
  });
});

function renderModal({
  taskInfoMap,
  sessions,
  focusTaskId = 't1',
  onClose = vi.fn(),
  onNavigate = vi.fn(),
}: {
  taskInfoMap: Map<string, TaskInfo>;
  sessions: ChatSessionListItem[];
  focusTaskId?: string;
  onClose?: () => void;
  onNavigate?: (sessionId: string) => void;
}) {
  return render(
    <HierarchyModal
      isOpen={true}
      onClose={onClose}
      focusTaskId={focusTaskId}
      taskInfoMap={taskInfoMap}
      sessions={sessions}
      onNavigate={onNavigate}
    />,
  );
}

function makeParentChildFixture() {
  const taskInfoMap = new Map<string, TaskInfo>([
    ['t1', makeTaskInfo({ id: 't1', title: 'Parent task', parentTaskId: null })],
    [
      't2',
      makeTaskInfo({
        id: 't2',
        title: 'Child task',
        parentTaskId: 't1',
        triggeredBy: 'mcp',
        dispatchDepth: 1,
      }),
    ],
  ]);
  const sessions: ChatSessionListItem[] = [
    makeSession({ id: 's1', taskId: 't1' }),
    makeSession({ id: 's2', taskId: 't2' }),
  ];
  return { taskInfoMap, sessions };
}

describe('HierarchyModal — filter empty state', () => {
  it('shows an empty state instead of the full tree when nothing matches', () => {
    const { taskInfoMap, sessions } = makeParentChildFixture();
    renderModal({ taskInfoMap, sessions });

    fireEvent.change(screen.getByLabelText('Filter tasks'), {
      target: { value: 'zzz-no-match' },
    });

    expect(screen.getByText(/No tasks match/)).toBeInTheDocument();
    expect(screen.getByText('0 matches')).toBeInTheDocument();
    expect(screen.queryByText('Parent task')).not.toBeInTheDocument();
    expect(screen.queryByText('Child task')).not.toBeInTheDocument();
  });

  it('restores the tree when the Clear filter button is clicked', () => {
    const { taskInfoMap, sessions } = makeParentChildFixture();
    renderModal({ taskInfoMap, sessions });

    fireEvent.change(screen.getByLabelText('Filter tasks'), {
      target: { value: 'zzz-no-match' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Clear filter' }));

    expect(screen.queryByText(/No tasks match/)).not.toBeInTheDocument();
    expect(screen.getByText('Parent task')).toBeInTheDocument();
    expect(screen.getByText('Child task')).toBeInTheDocument();
  });
});

describe('HierarchyModal — expand/collapse chevron', () => {
  it('collapses and re-expands children when the chevron is toggled', () => {
    const { taskInfoMap, sessions } = makeParentChildFixture();
    renderModal({ taskInfoMap, sessions });

    // Expanded by default (depth < 2)
    expect(screen.getByText('Child task')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Collapse subtasks' }));
    expect(screen.queryByText('Child task')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Expand subtasks' }));
    expect(screen.getByText('Child task')).toBeInTheDocument();
  });
});

describe('HierarchyModal — close control', () => {
  it('renders exactly one close button which calls onClose', () => {
    const { taskInfoMap, sessions } = makeParentChildFixture();
    const onClose = vi.fn();
    renderModal({ taskInfoMap, sessions, onClose });

    const closeButtons = screen.getAllByRole('button', { name: 'Close' });
    expect(closeButtons).toHaveLength(1);

    fireEvent.click(closeButtons[0]!);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
