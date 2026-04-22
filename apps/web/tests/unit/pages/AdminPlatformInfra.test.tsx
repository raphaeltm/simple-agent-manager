import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AdminPlatformInfra } from '../../../src/pages/AdminPlatformInfra';

const mockFetchAdminPlatformInfra = vi.fn();
const mockUpsertAssociation = vi.fn();
const mockDeleteAssociation = vi.fn();

vi.mock('../../../src/lib/api', () => ({
  fetchAdminPlatformInfra: (...args: unknown[]) => mockFetchAdminPlatformInfra(...args),
  upsertAdminPlatformInfraAssociation: (...args: unknown[]) => mockUpsertAssociation(...args),
  deleteAdminPlatformInfraAssociation: (...args: unknown[]) => mockDeleteAssociation(...args),
}));

describe('AdminPlatformInfra', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetchAdminPlatformInfra.mockResolvedValue({
      users: [
        { id: 'user-1', email: 'alice@example.com', name: 'Alice' },
        { id: 'user-2', email: 'bob@example.com', name: 'Bob' },
      ],
      nodes: [
        {
          id: 'node-1',
          ownerUserId: 'system_anonymous_trials',
          name: 'trial-node',
          status: 'running',
          healthStatus: 'healthy',
          cloudProvider: 'hetzner',
          vmSize: 'medium',
          vmLocation: 'nbg1',
          credentialSource: 'platform',
          lastHeartbeatAt: new Date().toISOString(),
          errorMessage: null,
          createdAt: new Date().toISOString(),
          workspaceCount: 1,
          activeWorkspaceCount: 1,
          trial: {
            id: 'trial-1',
            status: 'ready',
            repoOwner: 'acme',
            repoName: 'demo',
            claimedByUserId: null,
          },
          association: null,
        },
      ],
    });
  });

  function renderPage() {
    return render(
      <MemoryRouter>
        <AdminPlatformInfra />
      </MemoryRouter>,
    );
  }

  it('renders platform-managed nodes and trial context', async () => {
    renderPage();

    await waitFor(() => expect(screen.getByText('trial-node')).toBeInTheDocument());
    expect(screen.getByText('acme/demo')).toBeInTheDocument();
    expect(screen.getByText('No user associated')).toBeInTheDocument();
  });

  it('saves an association for a node', async () => {
    mockUpsertAssociation.mockResolvedValue({
      nodeId: 'node-1',
      userId: 'user-1',
      userEmail: 'alice@example.com',
      userName: 'Alice',
      reason: 'trial',
      associatedBy: 'admin-1',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    renderPage();
    await waitFor(() => expect(screen.getByText('trial-node')).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText('Associate trial-node with user'), {
      target: { value: 'user-1' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(mockUpsertAssociation).toHaveBeenCalledWith('node-1', {
        userId: 'user-1',
        reason: 'trial',
      });
    });
  });

  it('clears an existing association', async () => {
    mockFetchAdminPlatformInfra.mockResolvedValue({
      users: [{ id: 'user-1', email: 'alice@example.com', name: 'Alice' }],
      nodes: [
        {
          id: 'node-1',
          ownerUserId: 'system_anonymous_trials',
          name: 'trial-node',
          status: 'running',
          healthStatus: 'healthy',
          cloudProvider: 'hetzner',
          vmSize: 'medium',
          vmLocation: 'nbg1',
          credentialSource: 'platform',
          lastHeartbeatAt: new Date().toISOString(),
          errorMessage: null,
          createdAt: new Date().toISOString(),
          workspaceCount: 1,
          activeWorkspaceCount: 1,
          trial: null,
          association: {
            nodeId: 'node-1',
            userId: 'user-1',
            userEmail: 'alice@example.com',
            userName: 'Alice',
            reason: 'trial',
            associatedBy: 'admin-1',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        },
      ],
    });
    mockDeleteAssociation.mockResolvedValue({ success: true });

    renderPage();
    await waitFor(() => expect(screen.getByText('Alice · trial')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));

    await waitFor(() => {
      expect(mockDeleteAssociation).toHaveBeenCalledWith('node-1');
    });
  });
});
