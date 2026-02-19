import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { Task } from '@simple-agent-manager/shared';
import { TaskDependencyEditor } from '../../../../src/components/project/TaskDependencyEditor';
import { TaskList } from '../../../../src/components/project/TaskList';

const taskA: Task = {
  id: 'task-a',
  projectId: 'proj-1',
  userId: 'user-1',
  parentTaskId: null,
  workspaceId: null,
  title: 'Task A',
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

const taskB: Task = {
  ...taskA,
  id: 'task-b',
  title: 'Task B',
  blocked: true,
};

describe('Task dependencies UI', () => {
  it('shows blocked badge in task list rows', () => {
    render(
      <MemoryRouter>
        <TaskList
          tasks={[taskA, taskB]}
          projectId="proj-1"
          onDeleteTask={vi.fn()}
          onTransitionTask={vi.fn()}
          onDelegateTask={vi.fn()}
        />
      </MemoryRouter>
    );

    expect(screen.getByText('Blocked')).toBeInTheDocument();
  });

  it('adds and removes dependency edges via editor callbacks', async () => {
    const onAdd = vi.fn();
    const onRemove = vi.fn();

    render(
      <TaskDependencyEditor
        task={taskB}
        tasks={[taskA, taskB]}
        dependencies={[]}
        onAdd={onAdd}
        onRemove={onRemove}
        onClose={vi.fn()}
      />
    );

    fireEvent.change(screen.getByLabelText('Add dependency'), { target: { value: 'task-a' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));

    expect(onAdd).toHaveBeenCalledWith('task-a');

    render(
      <TaskDependencyEditor
        task={taskB}
        tasks={[taskA, taskB]}
        dependencies={[{ taskId: 'task-b', dependsOnTaskId: 'task-a', createdAt: '2026-02-18T00:00:00.000Z' }]}
        onAdd={onAdd}
        onRemove={onRemove}
        onClose={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(onRemove).toHaveBeenCalledWith('task-a');
  });
});
