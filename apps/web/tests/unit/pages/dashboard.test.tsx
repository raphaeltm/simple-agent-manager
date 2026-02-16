import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const mocks = vi.hoisted(() => ({
  listWorkspaces: vi.fn(),
  stopWorkspace: vi.fn(),
  restartWorkspace: vi.fn(),
  deleteWorkspace: vi.fn(),
}));

vi.mock('../../../src/lib/api', () => ({
  listWorkspaces: mocks.listWorkspaces,
  stopWorkspace: mocks.stopWorkspace,
  restartWorkspace: mocks.restartWorkspace,
  deleteWorkspace: mocks.deleteWorkspace,
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

const stoppedWorkspace = {
  ...runningWorkspace,
  id: 'ws-2',
  name: 'Stopped Workspace',
  displayName: 'Stopped Workspace',
  status: 'stopped' as const,
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
  });

  it('does not render UI standards quick action', async () => {
    renderDashboard();

    await waitFor(() => {
      expect(mocks.listWorkspaces).toHaveBeenCalled();
    });

    expect(screen.getByRole('button', { name: 'New Workspace' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Settings' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'UI Standards' })).not.toBeInTheDocument();
  });

  it('optimistically updates workspace status to stopping on stop', async () => {
    mocks.listWorkspaces.mockResolvedValue([runningWorkspace]);
    // Never resolve to observe the optimistic state
    mocks.stopWorkspace.mockReturnValue(new Promise(() => {}));

    renderDashboard();

    await waitFor(() => {
      expect(screen.getByText('My Workspace (running)')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));

    // Optimistic: status should change immediately to stopping
    await waitFor(() => {
      expect(screen.getByText('My Workspace (stopping)')).toBeInTheDocument();
    });
  });

  it('reverts optimistic stop on API failure', async () => {
    mocks.listWorkspaces.mockResolvedValue([runningWorkspace]);
    mocks.stopWorkspace.mockRejectedValue(new Error('Server error'));

    renderDashboard();

    await waitFor(() => {
      expect(screen.getByText('My Workspace (running)')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));

    // Should revert back to running after error
    await waitFor(() => {
      expect(screen.getByText('My Workspace (running)')).toBeInTheDocument();
    });
  });

  it('optimistically updates workspace status to creating on restart', async () => {
    mocks.listWorkspaces.mockResolvedValue([stoppedWorkspace]);
    mocks.restartWorkspace.mockReturnValue(new Promise(() => {}));

    renderDashboard();

    await waitFor(() => {
      expect(screen.getByText('Stopped Workspace (stopped)')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Restart' }));

    await waitFor(() => {
      expect(screen.getByText('Stopped Workspace (creating)')).toBeInTheDocument();
    });
  });

  it('reverts optimistic restart on API failure', async () => {
    mocks.listWorkspaces.mockResolvedValue([stoppedWorkspace]);
    mocks.restartWorkspace.mockRejectedValue(new Error('Server error'));

    renderDashboard();

    await waitFor(() => {
      expect(screen.getByText('Stopped Workspace (stopped)')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Restart' }));

    await waitFor(() => {
      expect(screen.getByText('Stopped Workspace (stopped)')).toBeInTheDocument();
    });
  });

  it('optimistically removes workspace from list on delete', async () => {
    mocks.listWorkspaces.mockResolvedValue([stoppedWorkspace]);
    mocks.deleteWorkspace.mockReturnValue(new Promise(() => {}));

    renderDashboard();

    await waitFor(() => {
      expect(screen.getByText('Stopped Workspace (stopped)')).toBeInTheDocument();
    });

    // Click delete on the workspace card to open confirm dialog
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    // Confirm dialog should appear
    await waitFor(() => {
      expect(screen.getByTestId('confirm-dialog')).toBeInTheDocument();
    });

    // Confirm the delete
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));

    // Workspace should be removed optimistically
    await waitFor(() => {
      expect(screen.queryByText('Stopped Workspace (stopped)')).not.toBeInTheDocument();
    });
  });

  it('reverts optimistic delete on API failure', async () => {
    mocks.listWorkspaces.mockResolvedValue([stoppedWorkspace]);
    mocks.deleteWorkspace.mockRejectedValue(new Error('Server error'));

    renderDashboard();

    await waitFor(() => {
      expect(screen.getByText('Stopped Workspace (stopped)')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => {
      expect(screen.getByTestId('confirm-dialog')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));

    // Should revert: workspace reappears after error
    await waitFor(() => {
      expect(screen.getByText('Stopped Workspace (stopped)')).toBeInTheDocument();
    });
  });
});
