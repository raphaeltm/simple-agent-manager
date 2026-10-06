import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import type { ChatSessionResponse } from '../../src/lib/api';
import { getHierarchyRole } from '../../src/pages/project-chat/HierarchyIndicator';
import { SessionTreeItem } from '../../src/pages/project-chat/SessionTreeItem';
import type { TaskInfo } from '../../src/pages/project-chat/useTaskGroups';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSession(overrides: Partial<ChatSessionResponse> = {}): ChatSessionResponse {
  return {
    id: overrides.id ?? 's1',
    workspaceId: null,
    taskId: null,
    topic: 'A chat',
    status: 'active',
    messageCount: 3,
    startedAt: 1_000_000,
    endedAt: null,
    createdAt: 1_000_000,
    ...overrides,
  };
}

function makeTaskInfo(overrides: Partial<TaskInfo> = {}): TaskInfo {
  return {
    id: overrides.id ?? 'task-1',
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

function renderItem(
  session: ChatSessionResponse,
  options: {
    selectedSessionId?: string | null;
    onSelect?: (id: string) => void;
    onShowHierarchy?: (taskId: string) => void;
    taskInfoMap?: Map<string, TaskInfo>;
    lineageText?: string;
    showOwnership?: boolean;
  } = {},
) {
  const onSelect = options.onSelect ?? vi.fn();
  const utils = render(
    <SessionTreeItem
      session={session}
      selectedSessionId={options.selectedSessionId ?? null}
      onSelect={onSelect}
      taskInfoMap={options.taskInfoMap ?? new Map()}
      onShowHierarchy={options.onShowHierarchy}
      lineageText={options.lineageText}
      showOwnership={options.showOwnership}
    />,
  );
  return { ...utils, onSelect };
}

// ---------------------------------------------------------------------------
// Flat rendering — sessions render directly without nesting
// ---------------------------------------------------------------------------

describe('SessionTreeItem — flat rendering', () => {
  it('renders the session topic', () => {
    renderItem(makeSession({ topic: 'My conversation' }));
    expect(screen.getByText('My conversation')).toBeInTheDocument();
  });

  it('calls onSelect with the session id when clicked', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    renderItem(makeSession({ id: 'target', topic: 'Pick me' }), { onSelect });

    const row = screen.getByText('Pick me').closest('button');
    expect(row).not.toBeNull();
    await user.click(row!);

    expect(onSelect).toHaveBeenCalledWith('target');
  });

  it('renders creator ownership labels when multiplayer affordances are active', () => {
    renderItem(makeSession({
      createdByUserId: 'user-2',
      createdBy: {
        id: 'user-2',
        name: 'Bob Collaborator',
        email: 'bob@example.com',
        image: null,
        avatarUrl: null,
      },
      isMine: false,
    }), { showOwnership: true });

    expect(screen.getByText('Bob Collaborator')).toBeInTheDocument();
  });

  it('hides creator ownership labels when multiplayer affordances are inactive', () => {
    renderItem(makeSession({
      createdByUserId: 'user-2',
      createdBy: {
        id: 'user-2',
        name: 'Bob Collaborator',
        email: 'bob@example.com',
        image: null,
        avatarUrl: null,
      },
      isMine: false,
    }), { showOwnership: false });

    expect(screen.queryByText('Bob Collaborator')).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Selected/hover state
// ---------------------------------------------------------------------------

describe('SessionTreeItem — hover does not erase selected background', () => {
  it('selected row does not apply the hover override class', () => {
    const { container } = renderItem(makeSession({ id: 'x', topic: 'Selected row' }), {
      selectedSessionId: 'x',
    });
    expect(container.innerHTML).not.toMatch(/hover:bg-\[var\(--sam-color-bg-surface-hover\)\]/);
  });

  it('unselected row still applies the hover override class', () => {
    const { container } = renderItem(makeSession({ id: 'x', topic: 'Unselected row' }), {
      selectedSessionId: null,
    });
    expect(container.innerHTML).toMatch(/hover:bg-\[var\(--sam-color-bg-surface-hover\)\]/);
  });
});

// ---------------------------------------------------------------------------
// Role-differentiated hierarchy icons
// ---------------------------------------------------------------------------

describe('getHierarchyRole', () => {
  it('returns "parent" for a task with MCP children but no parent', () => {
    const map = new Map<string, TaskInfo>([
      ['p', makeTaskInfo({ id: 'p', parentTaskId: null })],
      ['c', makeTaskInfo({ id: 'c', parentTaskId: 'p', triggeredBy: 'mcp', dispatchDepth: 1 })],
    ]);
    expect(getHierarchyRole('p', map)).toBe('parent');
  });

  it('returns "child" for an MCP subtask with no children of its own', () => {
    const map = new Map<string, TaskInfo>([
      ['p', makeTaskInfo({ id: 'p', parentTaskId: null })],
      ['c', makeTaskInfo({ id: 'c', parentTaskId: 'p', triggeredBy: 'mcp', dispatchDepth: 1 })],
    ]);
    expect(getHierarchyRole('c', map)).toBe('child');
  });

  it('returns "both" for a task that is both parent and MCP child', () => {
    const map = new Map<string, TaskInfo>([
      ['root', makeTaskInfo({ id: 'root', parentTaskId: null })],
      ['mid', makeTaskInfo({ id: 'mid', parentTaskId: 'root', triggeredBy: 'mcp', dispatchDepth: 1 })],
      ['leaf', makeTaskInfo({ id: 'leaf', parentTaskId: 'mid', triggeredBy: 'mcp', dispatchDepth: 2 })],
    ]);
    expect(getHierarchyRole('mid', map)).toBe('both');
  });

  it('returns "none" for a standalone task', () => {
    const map = new Map<string, TaskInfo>([
      ['solo', makeTaskInfo({ id: 'solo', parentTaskId: null })],
    ]);
    expect(getHierarchyRole('solo', map)).toBe('none');
  });

  it('returns "none" for a retry/fork (not triggeredBy=mcp)', () => {
    const map = new Map<string, TaskInfo>([
      ['p', makeTaskInfo({ id: 'p', parentTaskId: null })],
      ['r', makeTaskInfo({ id: 'r', parentTaskId: 'p', triggeredBy: 'user', dispatchDepth: 0 })],
    ]);
    expect(getHierarchyRole('r', map)).toBe('none');
  });
});

// ---------------------------------------------------------------------------
// Hierarchy button rendering and interaction
// ---------------------------------------------------------------------------

describe('SessionTreeItem — hierarchy button', () => {
  it('renders role-differentiated hierarchy button for a parent task', () => {
    const taskInfoMap = new Map<string, TaskInfo>([
      ['parent-task', makeTaskInfo({ id: 'parent-task' })],
      ['child-task', makeTaskInfo({ id: 'child-task', parentTaskId: 'parent-task', triggeredBy: 'mcp', dispatchDepth: 1 })],
    ]);
    const onShowHierarchy = vi.fn();

    renderItem(
      makeSession({ id: 's1', taskId: 'parent-task' }),
      { taskInfoMap, onShowHierarchy },
    );

    const btn = screen.getByRole('button', { name: 'Has subtasks' });
    expect(btn).toBeInTheDocument();
    expect(btn).toHaveStyle({ width: '22px', height: '22px' });
  });

  it('renders "Subtask" button for a child task', () => {
    const taskInfoMap = new Map<string, TaskInfo>([
      ['parent-task', makeTaskInfo({ id: 'parent-task' })],
      ['child-task', makeTaskInfo({ id: 'child-task', parentTaskId: 'parent-task', triggeredBy: 'mcp', dispatchDepth: 1 })],
    ]);
    const onShowHierarchy = vi.fn();

    renderItem(
      makeSession({ id: 's1', taskId: 'child-task' }),
      { taskInfoMap, onShowHierarchy },
    );

    expect(screen.getByRole('button', { name: 'Subtask' })).toBeInTheDocument();
  });

  it('calls onShowHierarchy with taskId when clicked', async () => {
    const user = userEvent.setup();
    const onShowHierarchy = vi.fn();
    const taskInfoMap = new Map<string, TaskInfo>([
      ['parent-task', makeTaskInfo({ id: 'parent-task' })],
      ['child-task', makeTaskInfo({ id: 'child-task', parentTaskId: 'parent-task', triggeredBy: 'mcp', dispatchDepth: 1 })],
    ]);

    renderItem(
      makeSession({ id: 'child-session', taskId: 'child-task' }),
      { taskInfoMap, onShowHierarchy },
    );

    await user.click(screen.getByRole('button', { name: 'Subtask' }));
    expect(onShowHierarchy).toHaveBeenCalledWith('child-task');
  });

  it('renders "Has parent & subtasks" button for a mid-chain (both) task', () => {
    const taskInfoMap = new Map<string, TaskInfo>([
      ['root', makeTaskInfo({ id: 'root', parentTaskId: null })],
      ['mid', makeTaskInfo({ id: 'mid', parentTaskId: 'root', triggeredBy: 'mcp', dispatchDepth: 1 })],
      ['leaf', makeTaskInfo({ id: 'leaf', parentTaskId: 'mid', triggeredBy: 'mcp', dispatchDepth: 2 })],
    ]);

    renderItem(
      makeSession({ id: 's1', taskId: 'mid' }),
      { taskInfoMap, onShowHierarchy: vi.fn() },
    );

    expect(screen.getByRole('button', { name: 'Has parent & subtasks' })).toBeInTheDocument();
  });

  it('does not render hierarchy button for standalone tasks', () => {
    const taskInfoMap = new Map<string, TaskInfo>([
      ['solo', makeTaskInfo({ id: 'solo' })],
    ]);

    renderItem(
      makeSession({ id: 's1', taskId: 'solo' }),
      { taskInfoMap, onShowHierarchy: vi.fn() },
    );

    expect(screen.queryByRole('button', { name: /subtask|has subtasks/i })).not.toBeInTheDocument();
  });
});
