import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
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
      <MemoryRouter>
        <TaskList
          tasks={[task]}
          projectId="proj-1"
          onDeleteTask={vi.fn()}
          onTransitionTask={vi.fn()}
          onDelegateTask={vi.fn()}
        />
      </MemoryRouter>
    );

    expect(screen.getByRole('link', { name: 'Draft task' })).toBeInTheDocument();
    expect(screen.getByLabelText('Transition Draft task')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delegate' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete' })).toBeInTheDocument();
  });

  it('calls callbacks for transition and actions', () => {
    const onDeleteTask = vi.fn();
    const onTransitionTask = vi.fn();
    const onDelegateTask = vi.fn();

    render(
      <MemoryRouter>
        <TaskList
          tasks={[task]}
          projectId="proj-1"
          onDeleteTask={onDeleteTask}
          onTransitionTask={onTransitionTask}
          onDelegateTask={onDelegateTask}
        />
      </MemoryRouter>
    );

    fireEvent.change(screen.getByLabelText('Transition Draft task'), { target: { value: 'ready' } });
    expect(onTransitionTask).toHaveBeenCalledWith(task, 'ready');

    fireEvent.click(screen.getByRole('button', { name: 'Delegate' }));
    expect(onDelegateTask).toHaveBeenCalledWith(task);

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(onDeleteTask).toHaveBeenCalledWith(task);
  });

  it('links task title to the detail page', () => {
    render(
      <MemoryRouter>
        <TaskList
          tasks={[task]}
          projectId="proj-1"
          onDeleteTask={vi.fn()}
          onTransitionTask={vi.fn()}
          onDelegateTask={vi.fn()}
        />
      </MemoryRouter>
    );

    const link = screen.getByRole('link', { name: 'Draft task' });
    expect(link).toHaveAttribute('href', '/projects/proj-1/tasks/task-1');
  });
});
