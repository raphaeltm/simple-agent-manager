import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

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
import { ToastProvider } from '../../../src/hooks/useToast';

function renderNode(path: string) {
  return render(
    <ToastProvider>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/nodes/:id" element={<Node />} />
          <Route path="/nodes" element={<div data-testid="nodes-list-page">Nodes</div>} />
          <Route path="/workspaces/new" element={<div data-testid="workspace-create-probe">probe</div>} />
        </Routes>
      </MemoryRouter>
    </ToastProvider>
  );
}

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
    renderNode('/nodes/node-1');

    await waitFor(() => {
      expect(screen.getAllByText('Node 1').length).toBeGreaterThanOrEqual(1);
    });

    expect(screen.getByRole('button', { name: /stop node/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /delete node/i })).toBeInTheDocument();
    expect(screen.getByText('Last Heartbeat')).toBeInTheDocument();

    // Events are fetched asynchronously via control plane proxy
    await waitFor(() => {
      expect(mocks.listNodeEvents).toHaveBeenCalled();
    });
    expect(screen.getByText('Node started')).toBeInTheDocument();
  });

  it('supports create-workspace navigation from node detail', async () => {
    renderNode('/nodes/node-1');

    await waitFor(() => {
      expect(screen.getAllByText('Node 1').length).toBeGreaterThanOrEqual(1);
    });

    fireEvent.click(screen.getByRole('button', { name: /create workspace/i }));
    expect(await screen.findByTestId('workspace-create-probe')).toBeInTheDocument();
  });

  it('shows stop/delete confirmations and calls lifecycle APIs', async () => {
    renderNode('/nodes/node-1');

    await waitFor(() => {
      expect(screen.getAllByText('Node 1').length).toBeGreaterThanOrEqual(1);
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

  it('shows error with retry when events fail to load', async () => {
    mocks.listNodeEvents.mockRejectedValue(new Error('Network timeout'));

    renderNode('/nodes/node-1');

    await waitFor(() => {
      expect(screen.getAllByText('Node 1').length).toBeGreaterThanOrEqual(1);
    });

    // Should show the events error with retry button
    await waitFor(() => {
      expect(screen.getByText('Failed to load events')).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();

    // Retry should call the API again
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

    fireEvent.click(screen.getByRole('button', { name: /retry/i }));

    await waitFor(() => {
      expect(screen.getByText('Node started')).toBeInTheDocument();
    });
    expect(screen.queryByText('Failed to load events')).not.toBeInTheDocument();
  });

  it('optimistically shows node as stopping when stop is clicked', async () => {
    mocks.stopNode.mockReturnValue(new Promise(() => {}));

    renderNode('/nodes/node-1');

    await waitFor(() => {
      expect(screen.getAllByText('Node 1').length).toBeGreaterThanOrEqual(1);
    });

    fireEvent.click(screen.getByRole('button', { name: /stop node/i }));

    // Optimistic: node status should change to stopping, button should be disabled
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /stopping/i })).toBeInTheDocument();
    });
  });

  it('reverts optimistic stop on API failure', async () => {
    mocks.stopNode.mockRejectedValue(new Error('Server error'));

    renderNode('/nodes/node-1');

    await waitFor(() => {
      expect(screen.getAllByText('Node 1').length).toBeGreaterThanOrEqual(1);
    });

    fireEvent.click(screen.getByRole('button', { name: /stop node/i }));

    // Should revert: stop button should be available again (not in "stopping" state)
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /^stop node$/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /^stop node$/i })).not.toBeDisabled();
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

    renderNode('/nodes/node-1');

    await waitFor(() => {
      expect(screen.getByText('Last Heartbeat')).toBeInTheDocument();
    });

    expect(screen.getAllByText(/stale/i).length).toBeGreaterThan(0);
  });
});
