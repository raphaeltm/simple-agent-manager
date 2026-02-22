import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const mocks = vi.hoisted(() => ({
  listWorkspaces: vi.fn(),
  listProjects: vi.fn(),
  stopWorkspace: vi.fn(),
  restartWorkspace: vi.fn(),
  deleteWorkspace: vi.fn(),
}));

vi.mock('../../../src/lib/api', () => ({
  listWorkspaces: mocks.listWorkspaces,
  stopWorkspace: mocks.stopWorkspace,
  restartWorkspace: mocks.restartWorkspace,
  deleteWorkspace: mocks.deleteWorkspace,
  listProjects: mocks.listProjects,
}));

vi.mock('../../../src/components/AuthProvider', () => ({
  useAuth: () => ({
    user: {
      id: 'user_123',
      email: 'dev@example.com',
      name: 'Dev User',
    },
  }),
}));

vi.mock('../../../src/components/UserMenu', () => ({
  UserMenu: () => <div data-testid="user-menu">user-menu</div>,
}));

vi.mock('../../../src/components/WorkspaceCard', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  WorkspaceCard: ({ workspace, onStop, onRestart, onDelete }: any) => (
    <div data-testid="workspace-card" data-status={workspace.status} data-id={workspace.id}>
      <span>{workspace.name} ({workspace.status})</span>
      {onStop && <button onClick={() => onStop(workspace.id)}>Stop</button>}
      {onRestart && <button onClick={() => onRestart(workspace.id)}>Restart</button>}
      {onDelete && <button onClick={() => onDelete(workspace.id)}>Delete</button>}
    </div>
  ),
}));

vi.mock('../../../src/components/ProjectSummaryCard', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ProjectSummaryCard: ({ project }: any) => (
    <div data-testid="project-summary-card">{project.name}</div>
  ),
}));

vi.mock('../../../src/components/ConfirmDialog', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ConfirmDialog: ({ isOpen, onConfirm, onClose, title }: any) => {
    if (!isOpen) return null;
    return (
      <div data-testid="confirm-dialog">
        <span>{title}</span>
        <button onClick={onConfirm}>Confirm</button>
        <button onClick={onClose}>Cancel</button>
      </div>
    );
  },
}));

import { Dashboard } from '../../../src/pages/Dashboard';
import { ToastProvider } from '../../../src/hooks/useToast';

const runningWorkspace = {
  id: 'ws-1',
  name: 'My Workspace',
  displayName: 'My Workspace',
  projectId: 'proj-1',
  repository: 'acme/repo',
  branch: 'main',
  status: 'running' as const,
  vmSize: 'medium',
  vmLocation: 'nbg1',
  vmIp: '1.1.1.1',
  nodeId: 'node-1',
  lastActivityAt: '2026-01-01T00:00:00.000Z',
  errorMessage: null,
  shutdownDeadline: null,
  idleTimeoutSeconds: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  url: 'https://ws-ws-1.example.com',
};

const unlinkedWorkspace = {
  ...runningWorkspace,
  id: 'ws-2',
  name: 'Unlinked Workspace',
  displayName: 'Unlinked Workspace',
  projectId: null,
  status: 'stopped' as const,
};

const sampleProject = {
  id: 'proj-1',
  name: 'Project One',
  repository: 'acme/repo-one',
  defaultBranch: 'main',
  status: 'active',
  activeWorkspaceCount: 1,
  activeSessionCount: 0,
  lastActivityAt: '2026-02-18T00:00:00.000Z',
};

function renderDashboard() {
  return render(
    <ToastProvider>
      <MemoryRouter>
        <Dashboard />
      </MemoryRouter>
    </ToastProvider>
  );
}

describe('Dashboard page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listWorkspaces.mockResolvedValue([]);
    mocks.listProjects.mockResolvedValue({ projects: [] });
  });

  it('shows projects section heading', async () => {
    renderDashboard();

    await waitFor(() => {
      expect(mocks.listWorkspaces).toHaveBeenCalled();
    });

    expect(screen.getByRole('heading', { name: 'Projects' })).toBeInTheDocument();
  });

  it('does not render quick-action navigation buttons', async () => {
    renderDashboard();

    await waitFor(() => {
      expect(mocks.listWorkspaces).toHaveBeenCalled();
    });

    expect(screen.queryByRole('button', { name: 'New Workspace' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Settings' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Nodes' })).not.toBeInTheDocument();
  });

  it('shows EmptyState with create action when no projects', async () => {
    renderDashboard();

    await waitFor(() => {
      expect(screen.getByText('No projects yet')).toBeInTheDocument();
    });

    expect(screen.getByRole('button', { name: 'Create Project' })).toBeInTheDocument();
  });

  it('renders projects with grouped workspaces', async () => {
    mocks.listProjects.mockResolvedValue({ projects: [sampleProject] });
    mocks.listWorkspaces.mockResolvedValue([runningWorkspace]);

    renderDashboard();

    await waitFor(() => {
      expect(screen.getByTestId('project-summary-card')).toBeInTheDocument();
    });

    expect(screen.getByText('Project One')).toBeInTheDocument();
    expect(screen.getByText('My Workspace (running)')).toBeInTheDocument();
  });

  it('shows unlinked workspaces in separate section', async () => {
    mocks.listProjects.mockResolvedValue({ projects: [sampleProject] });
    mocks.listWorkspaces.mockResolvedValue([runningWorkspace, unlinkedWorkspace]);

    renderDashboard();

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Unlinked Workspaces' })).toBeInTheDocument();
    });

    expect(screen.getByText('Unlinked Workspace (stopped)')).toBeInTheDocument();
  });

  it('optimistically updates workspace status to stopping on stop', async () => {
    mocks.listWorkspaces.mockResolvedValue([{ ...runningWorkspace, projectId: null }]);
    mocks.stopWorkspace.mockReturnValue(new Promise(() => {}));

    renderDashboard();

    await waitFor(() => {
      expect(screen.getByText('My Workspace (running)')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));

    await waitFor(() => {
      expect(screen.getByText('My Workspace (stopping)')).toBeInTheDocument();
    });
  });

  it('reverts optimistic stop on API failure', async () => {
    mocks.listWorkspaces.mockResolvedValue([{ ...runningWorkspace, projectId: null }]);
    mocks.stopWorkspace.mockRejectedValue(new Error('Server error'));

    renderDashboard();

    await waitFor(() => {
      expect(screen.getByText('My Workspace (running)')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));

    await waitFor(() => {
      expect(screen.getByText('My Workspace (running)')).toBeInTheDocument();
    });
  });

  it('optimistically removes workspace on delete confirmation', async () => {
    mocks.listWorkspaces.mockResolvedValue([unlinkedWorkspace]);
    mocks.deleteWorkspace.mockReturnValue(new Promise(() => {}));

    renderDashboard();

    await waitFor(() => {
      expect(screen.getByText('Unlinked Workspace (stopped)')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() => {
      expect(screen.getByTestId('confirm-dialog')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));

    await waitFor(() => {
      expect(screen.queryByText('Unlinked Workspace (stopped)')).not.toBeInTheDocument();
    });
  });

  it('reverts optimistic delete on API failure', async () => {
    mocks.listWorkspaces.mockResolvedValue([unlinkedWorkspace]);
    mocks.deleteWorkspace.mockRejectedValue(new Error('Server error'));

    renderDashboard();

    await waitFor(() => {
      expect(screen.getByText('Unlinked Workspace (stopped)')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => {
      expect(screen.getByTestId('confirm-dialog')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));

    await waitFor(() => {
      expect(screen.getByText('Unlinked Workspace (stopped)')).toBeInTheDocument();
    });
  });
});
