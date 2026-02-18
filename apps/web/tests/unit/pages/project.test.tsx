import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ToastProvider } from '../../../src/hooks/useToast';

const mocks = vi.hoisted(() => ({
  getProject: vi.fn(),
  listProjectTasks: vi.fn(),
  getProjectTask: vi.fn(),
  listTaskEvents: vi.fn(),
  listGitHubInstallations: vi.fn(),
  listWorkspaces: vi.fn(),
  updateProject: vi.fn(),
  createProjectTask: vi.fn(),
  updateProjectTask: vi.fn(),
  deleteProjectTask: vi.fn(),
  updateProjectTaskStatus: vi.fn(),
  addTaskDependency: vi.fn(),
  removeTaskDependency: vi.fn(),
  delegateTask: vi.fn(),
  deleteProject: vi.fn(),
}));

vi.mock('../../../src/lib/api', () => ({
  getProject: mocks.getProject,
  listProjectTasks: mocks.listProjectTasks,
  getProjectTask: mocks.getProjectTask,
  listTaskEvents: mocks.listTaskEvents,
  listGitHubInstallations: mocks.listGitHubInstallations,
  listWorkspaces: mocks.listWorkspaces,
  updateProject: mocks.updateProject,
  createProjectTask: mocks.createProjectTask,
  updateProjectTask: mocks.updateProjectTask,
  deleteProjectTask: mocks.deleteProjectTask,
  updateProjectTaskStatus: mocks.updateProjectTaskStatus,
  addTaskDependency: mocks.addTaskDependency,
  removeTaskDependency: mocks.removeTaskDependency,
  delegateTask: mocks.delegateTask,
  deleteProject: mocks.deleteProject,
}));

vi.mock('../../../src/components/UserMenu', () => ({
  UserMenu: () => <div data-testid="user-menu">user-menu</div>,
}));

import { Project } from '../../../src/pages/Project';

function renderProjectPage() {
  return render(
    <ToastProvider>
      <MemoryRouter initialEntries={['/projects/proj-1']}>
        <Routes>
          <Route path="/projects/:id" element={<Project />} />
        </Routes>
      </MemoryRouter>
    </ToastProvider>
  );
}

describe('Project page', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mocks.getProject.mockResolvedValue({
      id: 'proj-1',
      userId: 'user-1',
      name: 'Project One',
      description: 'Project description',
      installationId: 'inst-1',
      repository: 'acme/repo-one',
      defaultBranch: 'main',
      createdAt: '2026-02-18T00:00:00.000Z',
      updatedAt: '2026-02-18T00:00:00.000Z',
      summary: {
        linkedWorkspaces: 1,
        taskCountsByStatus: { draft: 1 },
      },
    });

    mocks.listProjectTasks.mockResolvedValue({
      tasks: [
        {
          id: 'task-1',
          projectId: 'proj-1',
          userId: 'user-1',
          parentTaskId: null,
          workspaceId: null,
          title: 'Draft task',
          description: 'Task description',
          status: 'draft',
          priority: 3,
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
        },
      ],
      nextCursor: null,
    });

    mocks.getProjectTask.mockResolvedValue({
      id: 'task-1',
      projectId: 'proj-1',
      userId: 'user-1',
      parentTaskId: null,
      workspaceId: null,
      title: 'Draft task',
      description: 'Task description',
      status: 'draft',
      priority: 3,
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
      dependencies: [],
    });

    mocks.listTaskEvents.mockResolvedValue({ events: [] });
    mocks.listGitHubInstallations.mockResolvedValue([
      {
        id: 'inst-1',
        userId: 'user-1',
        installationId: '123',
        accountType: 'personal',
        accountName: 'octocat',
        createdAt: '2026-02-18T00:00:00.000Z',
        updatedAt: '2026-02-18T00:00:00.000Z',
      },
    ]);
    mocks.listWorkspaces.mockResolvedValue([]);

    mocks.updateProject.mockResolvedValue({});
    mocks.createProjectTask.mockResolvedValue({});
    mocks.updateProjectTask.mockResolvedValue({});
    mocks.deleteProjectTask.mockResolvedValue({ success: true });
    mocks.updateProjectTaskStatus.mockResolvedValue({});
    mocks.addTaskDependency.mockResolvedValue({});
    mocks.removeTaskDependency.mockResolvedValue({ success: true });
    mocks.delegateTask.mockResolvedValue({});
    mocks.deleteProject.mockResolvedValue({ success: true });
  });

  it('loads project details and renders task backlog', async () => {
    renderProjectPage();

    await waitFor(() => {
      expect(mocks.getProject).toHaveBeenCalledWith('proj-1');
      expect(mocks.listProjectTasks).toHaveBeenCalledWith('proj-1', {
        status: undefined,
        minPriority: undefined,
        sort: 'createdAtDesc',
      });
    });

    expect(await screen.findByText('Project One')).toBeInTheDocument();
    expect(screen.getByText('Draft task')).toBeInTheDocument();
  });

  it('syncs task filters to list request', async () => {
    renderProjectPage();

    const statusSelect = await screen.findByLabelText('Status');
    fireEvent.change(statusSelect, { target: { value: 'ready' } });

    await waitFor(() => {
      expect(mocks.listProjectTasks).toHaveBeenLastCalledWith('proj-1', {
        status: 'ready',
        minPriority: undefined,
        sort: 'createdAtDesc',
      });
    });

    const sortSelect = screen.getByLabelText('Sort');
    fireEvent.change(sortSelect, { target: { value: 'priorityDesc' } });

    await waitFor(() => {
      expect(mocks.listProjectTasks).toHaveBeenLastCalledWith('proj-1', {
        status: 'ready',
        minPriority: undefined,
        sort: 'priorityDesc',
      });
    });
  });

  it('creates a task from the new-task form', async () => {
    renderProjectPage();

    fireEvent.click(await screen.findByRole('button', { name: 'New task' }));

    fireEvent.change(screen.getByPlaceholderText('Task title'), {
      target: { value: 'Write migration' },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Create Task' }));

    await waitFor(() => {
      expect(mocks.createProjectTask).toHaveBeenCalledWith('proj-1', {
        title: 'Write migration',
        description: undefined,
        priority: 0,
        parentTaskId: undefined,
        agentProfileHint: undefined,
      });
    });
  });

  it('supports multi-character typing across new-task form fields', async () => {
    renderProjectPage();

    fireEvent.click(await screen.findByRole('button', { name: 'New task' }));

    const titleInput = screen.getByPlaceholderText('Task title');
    fireEvent.change(titleInput, { target: { value: 'W' } });
    fireEvent.change(titleInput, { target: { value: 'Wr' } });
    fireEvent.change(titleInput, { target: { value: 'Write docs' } });

    fireEvent.change(screen.getByRole('textbox', { name: 'Description' }), {
      target: { value: 'Document edge cases for typing flows' },
    });
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Priority' }), {
      target: { value: '11' },
    });
    fireEvent.change(screen.getByPlaceholderText('Optional agent profile hint'), {
      target: { value: 'qa-reviewer' },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Create Task' }));

    await waitFor(() => {
      expect(mocks.createProjectTask).toHaveBeenCalledWith('proj-1', {
        title: 'Write docs',
        description: 'Document edge cases for typing flows',
        priority: 11,
        parentTaskId: undefined,
        agentProfileHint: 'qa-reviewer',
      });
    });
  });
});
