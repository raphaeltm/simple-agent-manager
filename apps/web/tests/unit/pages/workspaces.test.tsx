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

vi.mock('../../../src/components/UserMenu', () => ({
  UserMenu: () => <div data-testid="user-menu" />,
}));

vi.mock('../../../src/hooks/useIsStandalone', () => ({
  useIsStandalone: () => false,
}));

import { Workspaces } from '../../../src/pages/Workspaces';

const runningWorkspace = {
  id: 'ws-1',
  nodeId: 'node-1',
  name: 'workspace-1',
  displayName: 'My Workspace',
  repository: 'owner/repo',
  branch: 'main',
  status: 'running' as const,
  vmSize: 'medium' as const,
  vmLocation: 'nbg1' as const,
  vmIp: '1.2.3.4',
  lastActivityAt: '2026-03-01T00:00:00.000Z',
  errorMessage: null,
  createdAt: '2026-03-01T00:00:00.000Z',
  updatedAt: '2026-03-01T00:00:00.000Z',
};

const stoppedWorkspace = {
  ...runningWorkspace,
  id: 'ws-2',
  name: 'workspace-2',
  displayName: 'Stopped WS',
  status: 'stopped' as const,
  createdAt: '2026-02-28T00:00:00.000Z',
};

describe('Workspaces page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listWorkspaces.mockResolvedValue([runningWorkspace, stoppedWorkspace]);
    mocks.stopWorkspace.mockResolvedValue({ status: 'stopping' });
    mocks.restartWorkspace.mockResolvedValue({ status: 'creating' });
    mocks.deleteWorkspace.mockResolvedValue(undefined);
  });

  it('renders workspace list', async () => {
    render(
      <MemoryRouter>
        <Workspaces />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(mocks.listWorkspaces).toHaveBeenCalled();
    });

    expect(screen.getByText('My Workspace')).toBeInTheDocument();
    expect(screen.getByText('Stopped WS')).toBeInTheDocument();
  });

  it('shows empty state when no workspaces', async () => {
    mocks.listWorkspaces.mockResolvedValue([]);

    render(
      <MemoryRouter>
        <Workspaces />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(mocks.listWorkspaces).toHaveBeenCalled();
    });

    expect(screen.getByText('No workspaces yet')).toBeInTheDocument();
  });

  it('filters workspaces by status', async () => {
    render(
      <MemoryRouter>
        <Workspaces />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(mocks.listWorkspaces).toHaveBeenCalledWith(undefined);
    });

    const select = screen.getByLabelText('Filter by status');
    fireEvent.change(select, { target: { value: 'running' } });

    await waitFor(() => {
      expect(mocks.listWorkspaces).toHaveBeenCalledWith('running');
    });
  });

  it('shows error message on API failure', async () => {
    mocks.listWorkspaces.mockRejectedValue(new Error('Network error'));

    render(
      <MemoryRouter>
        <Workspaces />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText('Network error')).toBeInTheDocument();
    });
  });

  it('has page title', async () => {
    render(
      <MemoryRouter>
        <Workspaces />
      </MemoryRouter>
    );

    expect(screen.getByText('Workspaces')).toBeInTheDocument();
  });
});
