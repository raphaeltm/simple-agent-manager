import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { Task } from '@simple-agent-manager/shared';
import { TaskDelegateDialog } from '../../../../src/components/project/TaskDelegateDialog';

const task: Task = {
  id: 'task-1',
  projectId: 'proj-1',
  userId: 'user-1',
  parentTaskId: null,
  workspaceId: null,
  title: 'Delegate me',
  description: 'Ship polished task UX',
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
            createdAt: '2026-02-18T00:00:00.000Z',
            updatedAt: '2026-02-18T00:00:00.000Z',
          },
        ]}
        onClose={vi.fn()}
        onDelegate={onDelegate}
      />
    );

    fireEvent.change(screen.getByLabelText('Target workspace'), { target: { value: 'ws-1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Delegate' }));

    expect(onDelegate).toHaveBeenCalledWith('ws-1');
    expect(screen.getByText('Agent will receive')).toBeInTheDocument();
    expect(screen.getByText('Ship polished task UX')).toBeInTheDocument();
    expect(screen.getByText('Workspace One')).toBeInTheDocument();
  });

  it('shows an empty state when no running workspaces exist', () => {
    render(
      <TaskDelegateDialog
        open
        task={task}
        workspaces={[]}
        onClose={vi.fn()}
        onDelegate={vi.fn()}
      />
    );

    expect(screen.getByText('No running workspaces. Start a workspace first.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delegate' })).toBeDisabled();
  });
});
