import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';

const mocks = vi.hoisted(() => ({
  getNode: vi.fn(),
  listWorkspaces: vi.fn(),
  listNodeEvents: vi.fn(),
  stopNode: vi.fn(),
  deleteNode: vi.fn(),
}));

let confirmSpy: ReturnType<typeof vi.spyOn>;

vi.mock('../../../src/lib/api', () => ({
  getNode: mocks.getNode,
  listWorkspaces: mocks.listWorkspaces,
  listNodeEvents: mocks.listNodeEvents,
  stopNode: mocks.stopNode,
  deleteNode: mocks.deleteNode,
}));

vi.mock('../../../src/components/UserMenu', () => ({
  UserMenu: () => <div data-testid="user-menu" />,
}));

import { Node } from '../../../src/pages/Node';

describe('Node page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    mocks.getNode.mockResolvedValue({
      id: 'node-1',
      name: 'Node 1',
      status: 'running',
      healthStatus: 'healthy',
      vmSize: 'medium',
      vmLocation: 'nbg1',
      ipAddress: '1.1.1.1',
      lastHeartbeatAt: '2026-01-01T00:00:00.000Z',
      heartbeatStaleAfterSeconds: 180,
      errorMessage: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    mocks.listWorkspaces.mockResolvedValue([
      {
        id: 'ws-1',
        nodeId: 'node-1',
        name: 'Workspace 1',
        displayName: 'Workspace 1',
        repository: 'acme/repo',
        branch: 'main',
        status: 'running',
        vmSize: 'medium',
        vmLocation: 'nbg1',
        vmIp: null,
        lastActivityAt: null,
        errorMessage: null,
        shutdownDeadline: null,
        idleTimeoutSeconds: 0,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        url: 'https://ws-ws-1.example.com',
      },
    ]);
    mocks.listNodeEvents.mockResolvedValue({
      events: [
        {
          id: 'evt-1',
          nodeId: 'node-1',
          workspaceId: null,
          level: 'info',
          type: 'node.started',
          message: 'Node started',
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      ],
      nextCursor: null,
    });
    mocks.stopNode.mockResolvedValue({ status: 'stopped' });
    mocks.deleteNode.mockResolvedValue({ success: true });
  });

  it('renders node details and controls', async () => {
    render(
      <MemoryRouter initialEntries={['/nodes/node-1']}>
        <Routes>
          <Route path="/nodes/:id" element={<Node />} />
        </Routes>
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(mocks.getNode).toHaveBeenCalledWith('node-1');
    });

    expect(screen.getAllByText('Node 1').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByRole('button', { name: /stop node/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /delete node/i })).toBeInTheDocument();
    expect(screen.getByText('Node started')).toBeInTheDocument();
    expect(screen.getByText('Last Heartbeat')).toBeInTheDocument();
  });

  it('supports create-workspace navigation from node detail', async () => {
    function WorkspaceCreateProbe() {
      const location = useLocation();
      const state = location.state as { nodeId?: string } | null;
      return (
        <div data-testid="workspace-create-probe">
          {state?.nodeId || 'missing-node-id'}
        </div>
      );
    }

    render(
      <MemoryRouter initialEntries={['/nodes/node-1']}>
        <Routes>
          <Route path="/nodes/:id" element={<Node />} />
          <Route path="/workspaces/new" element={<WorkspaceCreateProbe />} />
        </Routes>
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(mocks.getNode).toHaveBeenCalledWith('node-1');
    });

    fireEvent.click(screen.getByRole('button', { name: /create workspace/i }));
    expect(await screen.findByTestId('workspace-create-probe')).toHaveTextContent('node-1');
  });

  it('shows stop/delete confirmations and calls lifecycle APIs', async () => {
    render(
      <MemoryRouter initialEntries={['/nodes/node-1']}>
        <Routes>
          <Route path="/nodes/:id" element={<Node />} />
          <Route path="/nodes" element={<div data-testid="nodes-list-page">Nodes</div>} />
        </Routes>
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(mocks.getNode).toHaveBeenCalledWith('node-1');
    });

    fireEvent.click(screen.getByRole('button', { name: /stop node/i }));
    await waitFor(() => {
      expect(confirmSpy).toHaveBeenCalledWith(
        expect.stringContaining('Stop node "Node 1"?')
      );
      expect(mocks.stopNode).toHaveBeenCalledWith('node-1');
    });

    fireEvent.click(screen.getByRole('button', { name: /delete node/i }));
    await waitFor(() => {
      expect(confirmSpy).toHaveBeenCalledWith(
        expect.stringContaining('Delete node "Node 1"?')
      );
      expect(mocks.deleteNode).toHaveBeenCalledWith('node-1');
    });
  });

  it('renders stale health state with heartbeat freshness text', async () => {
    mocks.getNode.mockResolvedValue({
      id: 'node-1',
      name: 'Node 1',
      status: 'running',
      healthStatus: 'stale',
      vmSize: 'medium',
      vmLocation: 'nbg1',
      ipAddress: '1.1.1.1',
      lastHeartbeatAt: '2026-01-01T00:00:00.000Z',
      heartbeatStaleAfterSeconds: 180,
      errorMessage: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });

    render(
      <MemoryRouter initialEntries={['/nodes/node-1']}>
        <Routes>
          <Route path="/nodes/:id" element={<Node />} />
        </Routes>
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(mocks.getNode).toHaveBeenCalledWith('node-1');
    });

    expect(screen.getByText('Last Heartbeat')).toBeInTheDocument();
    expect(screen.getAllByText(/stale/i).length).toBeGreaterThan(0);
  });
});
