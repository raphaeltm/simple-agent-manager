import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Navigate, Route, Routes } from 'react-router-dom';
import { ToastProvider } from '../../../src/hooks/useToast';

const mocks = vi.hoisted(() => ({
  getProject: vi.fn(),
  listProjectTasks: vi.fn(),
  getProjectTask: vi.fn(),
  listTaskEvents: vi.fn(),
  listGitHubInstallations: vi.fn(),
  listWorkspaces: vi.fn(),
  getProjectRuntimeConfig: vi.fn(),
  upsertProjectRuntimeEnvVar: vi.fn(),
  deleteProjectRuntimeEnvVar: vi.fn(),
  upsertProjectRuntimeFile: vi.fn(),
  deleteProjectRuntimeFile: vi.fn(),
  createWorkspace: vi.fn(),
  updateProject: vi.fn(),
  createProjectTask: vi.fn(),
  updateProjectTask: vi.fn(),
  deleteProjectTask: vi.fn(),
  updateProjectTaskStatus: vi.fn(),
  addTaskDependency: vi.fn(),
  removeTaskDependency: vi.fn(),
  delegateTask: vi.fn(),
  deleteProject: vi.fn(),
  listActivityEvents: vi.fn(),
  listChatSessions: vi.fn(),
}));

vi.mock('../../../src/lib/api', () => ({
  getProject: mocks.getProject,
  listProjectTasks: mocks.listProjectTasks,
  getProjectTask: mocks.getProjectTask,
  listTaskEvents: mocks.listTaskEvents,
  listGitHubInstallations: mocks.listGitHubInstallations,
  listWorkspaces: mocks.listWorkspaces,
  getProjectRuntimeConfig: mocks.getProjectRuntimeConfig,
  upsertProjectRuntimeEnvVar: mocks.upsertProjectRuntimeEnvVar,
  deleteProjectRuntimeEnvVar: mocks.deleteProjectRuntimeEnvVar,
  upsertProjectRuntimeFile: mocks.upsertProjectRuntimeFile,
  deleteProjectRuntimeFile: mocks.deleteProjectRuntimeFile,
  createWorkspace: mocks.createWorkspace,
  updateProject: mocks.updateProject,
  createProjectTask: mocks.createProjectTask,
  updateProjectTask: mocks.updateProjectTask,
  deleteProjectTask: mocks.deleteProjectTask,
  updateProjectTaskStatus: mocks.updateProjectTaskStatus,
  addTaskDependency: mocks.addTaskDependency,
  removeTaskDependency: mocks.removeTaskDependency,
  delegateTask: mocks.delegateTask,
  deleteProject: mocks.deleteProject,
  listActivityEvents: mocks.listActivityEvents,
  listChatSessions: mocks.listChatSessions,
}));

vi.mock('../../../src/components/UserMenu', () => ({
  UserMenu: () => <div data-testid="user-menu">user-menu</div>,
}));

import { Project } from '../../../src/pages/Project';
import { ProjectOverview } from '../../../src/pages/ProjectOverview';
import { ProjectTasks } from '../../../src/pages/ProjectTasks';
import { ProjectSettings } from '../../../src/pages/ProjectSettings';
import { ProjectActivity } from '../../../src/pages/ProjectActivity';

function renderProjectPage(path = '/projects/proj-1/overview') {
  return render(
    <ToastProvider>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/projects/:id" element={<Project />}>
            <Route index element={<Navigate to="overview" replace />} />
            <Route path="overview" element={<ProjectOverview />} />
            <Route path="tasks" element={<ProjectTasks />} />
            <Route path="settings" element={<ProjectSettings />} />
            <Route path="activity" element={<ProjectActivity />} />
          </Route>
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
    mocks.getProjectRuntimeConfig.mockResolvedValue({
      envVars: [],
      files: [],
    });
    mocks.upsertProjectRuntimeEnvVar.mockResolvedValue({
      envVars: [],
      files: [],
    });
    mocks.createWorkspace.mockResolvedValue({ id: 'ws-1' });
    mocks.updateProject.mockResolvedValue({});
    mocks.createProjectTask.mockResolvedValue({});
    mocks.deleteProjectTask.mockResolvedValue({ success: true });
    mocks.updateProjectTaskStatus.mockResolvedValue({});
    mocks.delegateTask.mockResolvedValue({});
    mocks.deleteProject.mockResolvedValue({ success: true });
    mocks.listActivityEvents.mockResolvedValue({ events: [], hasMore: false });
    mocks.listChatSessions.mockResolvedValue({ sessions: [], total: 0 });
  });

  it('loads project details and renders task backlog on tasks tab', async () => {
    renderProjectPage('/projects/proj-1/tasks');

    await waitFor(() => {
      expect(mocks.getProject).toHaveBeenCalledWith('proj-1');
      expect(mocks.listProjectTasks).toHaveBeenCalledWith('proj-1', {
        status: undefined,
        minPriority: undefined,
        sort: 'createdAtDesc',
      });
    });

    expect(await screen.findByRole('heading', { name: 'Project One' })).toBeInTheDocument();
    expect(await screen.findByRole('link', { name: 'Draft task' })).toBeInTheDocument();
  });

  it('syncs task filters to list request', async () => {
    renderProjectPage('/projects/proj-1/tasks');

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
    renderProjectPage('/projects/proj-1/tasks');

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
    renderProjectPage('/projects/proj-1/tasks');

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

  it('saves runtime env vars from project settings tab', async () => {
    mocks.upsertProjectRuntimeEnvVar.mockResolvedValue({
      envVars: [{ key: 'API_TOKEN', value: null, isSecret: true, hasValue: true }],
      files: [],
    });

    renderProjectPage('/projects/proj-1/settings');

    fireEvent.change(await screen.findByLabelText('Runtime env key'), {
      target: { value: 'API_TOKEN' },
    });
    fireEvent.change(screen.getByLabelText('Runtime env value'), {
      target: { value: 'secret-value' },
    });
    fireEvent.click(screen.getByLabelText('Secret'));
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));

    await waitFor(() => {
      expect(mocks.upsertProjectRuntimeEnvVar).toHaveBeenCalledWith('proj-1', {
        key: 'API_TOKEN',
        value: 'secret-value',
        isSecret: true,
      });
    });
  });

  it('launches a workspace from project overview', async () => {
    renderProjectPage('/projects/proj-1/overview');
    fireEvent.click(await screen.findByRole('button', { name: 'Launch Workspace' }));

    await waitFor(() => {
      expect(mocks.createWorkspace).toHaveBeenCalledWith({
        name: 'Project One Workspace',
        projectId: 'proj-1',
      });
    });
  });

  it('renders chat-first layout without tabs', async () => {
    renderProjectPage();
    await screen.findByRole('heading', { name: 'Project One' });
    // Tabs were removed in 022 — project page is now chat-first
    expect(screen.queryByRole('tab')).not.toBeInTheDocument();
  });

  it('renders Status button next to Settings button', async () => {
    renderProjectPage();
    await screen.findByRole('heading', { name: 'Project One' });

    const statusBtn = screen.getByRole('button', { name: 'Project status' });
    const settingsBtn = screen.getByRole('button', { name: 'Project settings' });
    expect(statusBtn).toBeInTheDocument();
    expect(settingsBtn).toBeInTheDocument();
  });

  it('opens project info panel when Status button is clicked', async () => {
    renderProjectPage();
    await screen.findByRole('heading', { name: 'Project One' });

    const statusBtn = screen.getByRole('button', { name: 'Project status' });
    expect(statusBtn).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(statusBtn);

    await waitFor(() => {
      expect(screen.getByText('Project Status')).toBeInTheDocument();
    });
  });

  it('shows Project Views section in settings drawer', async () => {
    renderProjectPage();
    await screen.findByRole('heading', { name: 'Project One' });

    fireEvent.click(screen.getByRole('button', { name: 'Project settings' }));

    await waitFor(() => {
      expect(screen.getByText('Project Views')).toBeInTheDocument();
    });

    expect(screen.getByText('Overview')).toBeInTheDocument();
    expect(screen.getByText('Tasks')).toBeInTheDocument();
    expect(screen.getByText('Activity')).toBeInTheDocument();
  });

  it('settings drawer has dialog ARIA role', async () => {
    renderProjectPage();
    await screen.findByRole('heading', { name: 'Project One' });

    fireEvent.click(screen.getByRole('button', { name: 'Project settings' }));

    await waitFor(() => {
      expect(screen.getByRole('dialog', { name: 'Project Settings' })).toBeInTheDocument();
    });
  });

  it('navigates when Project Views link is clicked in settings drawer', async () => {
    renderProjectPage('/projects/proj-1/overview');
    await screen.findByRole('heading', { name: 'Project One' });

    fireEvent.click(screen.getByRole('button', { name: 'Project settings' }));

    await waitFor(() => {
      expect(screen.getByText('Project Views')).toBeInTheDocument();
    });

    // Click "Tasks" link
    const tasksButton = screen.getByRole('button', { name: /Tasks/ });
    fireEvent.click(tasksButton);

    // Drawer should close (no longer visible)
    await waitFor(() => {
      expect(screen.queryByText('Project Views')).not.toBeInTheDocument();
    });
  });
});
