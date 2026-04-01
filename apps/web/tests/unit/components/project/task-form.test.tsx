import type { Task } from '@simple-agent-manager/shared';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { TaskForm } from '../../../../src/components/project/TaskForm';

// Mock the API module so listAgentProfiles doesn't make real requests
vi.mock('../../../../src/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../src/lib/api')>()),
  listAgentProfiles: vi.fn().mockResolvedValue([
    {
      id: 'prof-1',
      projectId: 'proj-1',
      userId: 'user-1',
      name: 'Fast Implementer',
      description: null,
      agentType: 'claude-code',
      model: 'claude-sonnet-4-5-20250929',
      permissionMode: null,
      systemPromptAppend: null,
      maxTurns: null,
      timeoutMinutes: null,
      vmSizeOverride: null,
      provider: null,
      vmLocation: null,
      workspaceProfile: null,
      taskMode: null,
      isBuiltin: false,
      createdAt: '2026-03-15T00:00:00Z',
      updatedAt: '2026-03-15T00:00:00Z',
    },
  ]),
}));

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
        projectId="proj-1"
        tasks={[taskA]}
        onSubmit={onSubmit}
      />,
    );

    fireEvent.change(screen.getByPlaceholderText('Task title'), { target: { value: 'Write tests' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Description' }), {
      target: { value: 'Cover critical user flows' },
    });
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Priority' }), { target: { value: '12' } });
    fireEvent.change(screen.getByRole('combobox', { name: 'Parent task' }), { target: { value: 'task-a' } });

    // Wait for profiles to load and select one
    await waitFor(() => {
      expect(screen.getByLabelText('Agent profile')).toBeInTheDocument();
    });
    fireEvent.change(screen.getByLabelText('Agent profile'), { target: { value: 'prof-1' } });

    fireEvent.click(screen.getByRole('button', { name: 'Create Task' }));

    expect(onSubmit).toHaveBeenCalledWith({
      title: 'Write tests',
      description: 'Cover critical user flows',
      priority: 12,
      parentTaskId: 'task-a',
      agentProfileId: 'prof-1',
    });
  });

  it('preserves input while typing multiple consecutive characters', () => {
    render(
      <TaskForm
        mode="create"
        projectId="proj-1"
        tasks={[]}
        onSubmit={vi.fn()}
      />,
    );

    const titleInput = screen.getByPlaceholderText('Task title') as HTMLInputElement;
    const descriptionInput = screen.getByRole('textbox', { name: 'Description' }) as HTMLTextAreaElement;

    fireEvent.change(titleInput, { target: { value: 'a' } });
    fireEvent.change(titleInput, { target: { value: 'ab' } });
    fireEvent.change(titleInput, { target: { value: 'abc' } });

    fireEvent.change(descriptionInput, { target: { value: 'x' } });
    fireEvent.change(descriptionInput, { target: { value: 'xy' } });
    fireEvent.change(descriptionInput, { target: { value: 'xyz' } });

    expect(titleInput.value).toBe('abc');
    expect(descriptionInput.value).toBe('xyz');
  });

  it('submits with empty agentProfileId when no profile is selected', async () => {
    const onSubmit = vi.fn();

    render(
      <TaskForm
        mode="create"
        projectId="proj-1"
        tasks={[]}
        onSubmit={onSubmit}
      />,
    );

    fireEvent.change(screen.getByPlaceholderText('Task title'), { target: { value: 'Simple task' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create Task' }));

    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Simple task',
        agentProfileId: '',
      }),
    );
  });
});
