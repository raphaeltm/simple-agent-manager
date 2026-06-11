import { render, screen } from '@testing-library/react';
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
