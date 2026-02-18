import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { Task } from '@simple-agent-manager/shared';
import { TaskForm } from '../../../../src/components/project/TaskForm';

const taskA: Task = {
  id: 'task-a',
  projectId: 'proj-1',
  userId: 'user-1',
  parentTaskId: null,
  workspaceId: null,
  title: 'Task A',
  description: 'Task A description',
  status: 'draft',
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

describe('TaskForm', () => {
  it('accepts multi-character typing across fields and submits values', async () => {
    const onSubmit = vi.fn();

    render(
      <TaskForm
        mode="create"
        tasks={[taskA]}
        onSubmit={onSubmit}
      />
    );

    fireEvent.change(screen.getByPlaceholderText('Task title'), { target: { value: 'Write tests' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Description' }), {
      target: { value: 'Cover critical user flows' },
    });
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Priority' }), { target: { value: '12' } });
    fireEvent.change(screen.getByRole('combobox', { name: 'Parent task' }), { target: { value: 'task-a' } });
    fireEvent.change(screen.getByPlaceholderText('Optional agent profile hint'), {
      target: { value: 'frontend-specialist' },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Create Task' }));

    expect(onSubmit).toHaveBeenCalledWith({
      title: 'Write tests',
      description: 'Cover critical user flows',
      priority: 12,
      parentTaskId: 'task-a',
      agentProfileHint: 'frontend-specialist',
    });
  });

  it('preserves input while typing multiple consecutive characters', () => {
    render(
      <TaskForm
        mode="create"
        tasks={[]}
        onSubmit={vi.fn()}
      />
    );

    const titleInput = screen.getByPlaceholderText('Task title') as HTMLInputElement;
    const descriptionInput = screen.getByRole('textbox', { name: 'Description' }) as HTMLTextAreaElement;
    const hintInput = screen.getByPlaceholderText('Optional agent profile hint') as HTMLInputElement;

    fireEvent.change(titleInput, { target: { value: 'a' } });
    fireEvent.change(titleInput, { target: { value: 'ab' } });
    fireEvent.change(titleInput, { target: { value: 'abc' } });

    fireEvent.change(descriptionInput, { target: { value: 'x' } });
    fireEvent.change(descriptionInput, { target: { value: 'xy' } });
    fireEvent.change(descriptionInput, { target: { value: 'xyz' } });

    fireEvent.change(hintInput, { target: { value: 'm' } });
    fireEvent.change(hintInput, { target: { value: 'mo' } });
    fireEvent.change(hintInput, { target: { value: 'mod' } });

    expect(titleInput.value).toBe('abc');
    expect(descriptionInput.value).toBe('xyz');
    expect(hintInput.value).toBe('mod');
  });
});
