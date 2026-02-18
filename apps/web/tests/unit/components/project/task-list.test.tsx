import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { Task } from '@simple-agent-manager/shared';
import { TaskList } from '../../../../src/components/project/TaskList';

const task: Task = {
  id: 'task-1',
  projectId: 'proj-1',
  userId: 'user-1',
  parentTaskId: null,
  workspaceId: null,
  title: 'Draft task',
  description: 'Task description',
  status: 'draft',
  priority: 2,
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

describe('TaskList', () => {
  it('renders tasks and status controls', () => {
    render(
      <TaskList
        tasks={[task]}
        onSelectTask={vi.fn()}
        onEditTask={vi.fn()}
        onDeleteTask={vi.fn()}
        onTransitionTask={vi.fn()}
        onManageDependencies={vi.fn()}
        onDelegateTask={vi.fn()}
      />
    );

    expect(screen.getByText('Draft task')).toBeInTheDocument();
    expect(screen.getByLabelText('Transition Draft task')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Dependencies' })).toBeInTheDocument();
  });

  it('calls callbacks for selection, transition, and actions', () => {
    const onSelectTask = vi.fn();
    const onEditTask = vi.fn();
    const onDeleteTask = vi.fn();
    const onTransitionTask = vi.fn();
    const onManageDependencies = vi.fn();
    const onDelegateTask = vi.fn();

    render(
      <TaskList
        tasks={[task]}
        onSelectTask={onSelectTask}
        onEditTask={onEditTask}
        onDeleteTask={onDeleteTask}
        onTransitionTask={onTransitionTask}
        onManageDependencies={onManageDependencies}
        onDelegateTask={onDelegateTask}
      />
    );

    fireEvent.click(screen.getByText('Draft task'));
    expect(onSelectTask).toHaveBeenCalledWith('task-1');

    fireEvent.change(screen.getByLabelText('Transition Draft task'), { target: { value: 'ready' } });
    expect(onTransitionTask).toHaveBeenCalledWith(task, 'ready');

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect(onEditTask).toHaveBeenCalledWith(task);

    fireEvent.click(screen.getByRole('button', { name: 'Dependencies' }));
    expect(onManageDependencies).toHaveBeenCalledWith(task);

    fireEvent.click(screen.getByRole('button', { name: 'Delegate' }));
    expect(onDelegateTask).toHaveBeenCalledWith(task);

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(onDeleteTask).toHaveBeenCalledWith(task);
  });
});
