import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { Task, TaskDetailResponse } from '@simple-agent-manager/shared';
import { TaskDelegateDialog } from '../../../../src/components/project/TaskDelegateDialog';
import { TaskDetailPanel } from '../../../../src/components/project/TaskDetailPanel';

const task: Task = {
  id: 'task-1',
  projectId: 'proj-1',
  userId: 'user-1',
  parentTaskId: null,
  workspaceId: null,
  title: 'Delegate me',
  description: null,
  status: 'ready',
  priority: 1,
  agentProfileHint: null,
  blocked: false,
  startedAt: null,
  completedAt: null,
  errorMessage: null,
  outputSummary: null,
  outputBranch: null,
  outputPrUrl: null,
  createdAt: '2026-02-18T00:00:00.000Z',
  updatedAt: '2026-02-18T00:00:00.000Z',
};

describe('Task delegation UI', () => {
  it('delegates selected task to a running workspace', async () => {
    const onDelegate = vi.fn();

    render(
      <TaskDelegateDialog
        open
        task={task}
        workspaces={[
          {
            id: 'ws-1',
            nodeId: 'node-1',
            name: 'Workspace One',
            displayName: 'Workspace One',
            repository: 'acme/repo',
            branch: 'main',
            status: 'running',
            vmSize: 'small',
            vmLocation: 'nbg1',
            vmIp: null,
            lastActivityAt: null,
            errorMessage: null,
            shutdownDeadline: null,
            idleTimeoutSeconds: 1800,
            createdAt: '2026-02-18T00:00:00.000Z',
            updatedAt: '2026-02-18T00:00:00.000Z',
          },
        ]}
        onClose={vi.fn()}
        onDelegate={onDelegate}
      />
    );

    fireEvent.change(screen.getByLabelText('Running workspace'), { target: { value: 'ws-1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Delegate' }));

    expect(onDelegate).toHaveBeenCalledWith('ws-1');
  });

  it('renders task output metadata in detail panel', () => {
    const detail: TaskDetailResponse = {
      ...task,
      blocked: false,
      status: 'completed',
      workspaceId: 'ws-1',
      outputSummary: 'Implemented feature',
      outputBranch: 'feature/task-1',
      outputPrUrl: 'https://github.com/acme/repo/pull/1',
      dependencies: [],
    };

    render(
      <TaskDetailPanel
        task={detail}
        events={[
          {
            id: 'event-1',
            taskId: 'task-1',
            fromStatus: 'in_progress',
            toStatus: 'completed',
            actorType: 'workspace_callback',
            actorId: 'ws-1',
            reason: null,
            createdAt: '2026-02-18T00:01:00.000Z',
          },
        ]}
        onClose={vi.fn()}
      />
    );

    expect(screen.getByText('Implemented feature')).toBeInTheDocument();
    expect(screen.getByText('feature/task-1')).toBeInTheDocument();
    expect(screen.getByText('https://github.com/acme/repo/pull/1')).toBeInTheDocument();
    expect(screen.getByText(/in_progress/)).toBeInTheDocument();
  });
});
