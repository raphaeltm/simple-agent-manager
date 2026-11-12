import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// jsdom does not implement window.matchMedia — stub it for hooks that check media queries
beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
});
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';

const mocks = vi.hoisted(() => ({
  getNode: vi.fn(),
  listWorkspaces: vi.fn(),
  listNodeEvents: vi.fn(),
  stopNode: vi.fn(),
  deleteNode: vi.fn(),
  confirmNodeManualDeletion: vi.fn(),
  getNodeSystemInfo: vi.fn(),
  getNodeLogs: vi.fn().mockResolvedValue({ entries: [], nextCursor: null, hasMore: false }),
  getNodeLogStreamUrl: vi.fn().mockReturnValue('ws://localhost/logs/stream'),
}));

let confirmSpy: ReturnType<typeof vi.spyOn>;

// `useQueryScope()` reads the authenticated identity, and every migrated query
// is keyed by it. Without a provider `useAuth` throws, so supply a stable identity.
const auth = vi.hoisted(() => ({ isSuperadmin: false }));
vi.mock('../../../src/components/AuthProvider', () => ({
  useAuth: () => ({
    user: { id: 'user-1', email: 'user@example.com', name: 'Test User' },
    isSuperadmin: auth.isSuperadmin,
  }),
}));

vi.mock('../../../src/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/lib/api')>()),
  getNode: mocks.getNode,
  listWorkspaces: mocks.listWorkspaces,
  listNodeEvents: mocks.listNodeEvents,
  stopNode: mocks.stopNode,
  deleteNode: mocks.deleteNode,
  confirmNodeManualDeletion: mocks.confirmNodeManualDeletion,
  getNodeSystemInfo: mocks.getNodeSystemInfo,
  getNodeLogs: mocks.getNodeLogs,
  getNodeLogStreamUrl: mocks.getNodeLogStreamUrl,
}));

vi.mock('../../../src/hooks/useNodeSystemInfo', () => ({
  useNodeSystemInfo: () => ({ systemInfo: null, loading: false, isRefreshing: false, error: null }),
}));

vi.mock('../../../src/hooks/useNodeLogs', () => ({
  useNodeLogs: () => ({
    entries: [],
    loading: false,
    error: null,
    hasMore: false,
    streaming: false,
    paused: false,
    containers: [],
    containersLoading: false,
    filter: { source: 'all', level: 'info', container: '', search: '' },
    setSource: vi.fn(),
    setLevel: vi.fn(),
    setContainer: vi.fn(),
    setSearch: vi.fn(),
    loadMore: vi.fn(),
    togglePause: vi.fn(),
    refresh: vi.fn(),
  }),
}));

vi.mock('../../../src/components/UserMenu', () => ({
  UserMenu: () => <div data-testid="user-menu" />,
}));

import { ToastProvider } from '../../../src/hooks/useToast';
import { Node } from '../../../src/pages/Node';
import { QueryTestWrapper } from '../../test-utils/query-test-utils';

function renderNode(path: string) {
  return render(
    <ToastProvider>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/nodes/:id" element={<Node />} />
          <Route path="/nodes" element={<div data-testid="nodes-list-page">Nodes</div>} />
        </Routes>
      </MemoryRouter>
    </ToastProvider>,
    { wrapper: QueryTestWrapper }
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
    mocks.confirmNodeManualDeletion.mockResolvedValue({ success: true });
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
    expect(await screen.findByText('Node started')).toBeInTheDocument();
  });

  it('does not offer manual workspace creation from node detail', async () => {
    renderNode('/nodes/node-1');

    await waitFor(() => {
      expect(screen.getAllByText('Node 1').length).toBeGreaterThanOrEqual(1);
    });

    // Liveness: the page actions and the workspaces section rendered.
    expect(screen.getByRole('button', { name: /stop node/i })).toBeInTheDocument();
    expect(await screen.findByText('Workspaces')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /create workspace/i })).not.toBeInTheDocument();
  });

  it('shows stop/delete confirmations and calls lifecycle APIs', async () => {
    renderNode('/nodes/node-1');

    await waitFor(() => {
      expect(screen.getAllByText('Node 1').length).toBeGreaterThanOrEqual(1);
    });

    fireEvent.click(screen.getByRole('button', { name: /stop node/i }));
    await waitFor(() => {
      expect(confirmSpy).toHaveBeenCalledWith(expect.stringContaining('Stop node "Node 1"?'));
      expect(mocks.stopNode).toHaveBeenCalledWith('node-1');
    });

    fireEvent.click(screen.getByRole('button', { name: /delete node/i }));
    await waitFor(() => {
      expect(confirmSpy).toHaveBeenCalledWith(expect.stringContaining('Delete node "Node 1"?'));
      expect(mocks.deleteNode).toHaveBeenCalledWith('node-1');
    });
  });

  it('lets the owner remove a node SAM failed to delete, after confirming', async () => {
    mocks.getNode.mockResolvedValue({
      ...(await mocks.getNode()),
      status: 'destroying',
      healthStatus: 'stale',
      cloudProvider: 'hetzner',
      errorMessage:
        'Cannot strictly delete node node-1: exact provider credential binding is missing',
    });
    renderNode('/nodes/node-1');

    const button = await screen.findByRole('button', { name: /i already deleted this server/i });

    // Declining the confirmation must not touch the node.
    confirmSpy.mockReturnValueOnce(false);
    fireEvent.click(button);
    expect(confirmSpy).toHaveBeenLastCalledWith(
      expect.stringContaining('Only continue if you have already deleted it yourself')
    );
    expect(mocks.confirmNodeManualDeletion).not.toHaveBeenCalled();

    fireEvent.click(button);
    await waitFor(() => {
      expect(mocks.confirmNodeManualDeletion).toHaveBeenCalledWith('node-1');
    });
    expect(await screen.findByTestId('nodes-list-page')).toBeInTheDocument();
  });

  it('lets a superadmin retire a SAM-capacity node by typing its name when the provider cannot be asked', async () => {
    auth.isSuperadmin = true;
    const { ApiClientError } = await import('../../../src/lib/api');
    mocks.getNode.mockResolvedValue({
      ...(await mocks.getNode()),
      status: 'destroying',
      healthStatus: 'stale',
      cloudProvider: 'gcp',
    });
    mocks.confirmNodeManualDeletion.mockRejectedValueOnce(
      new ApiClientError(
        'OPERATOR_CONFIRMATION_REQUIRED',
        'SAM cannot ask the provider whether this server still exists. Type the node name "t4-node-probe" to remove it.',
        409
      )
    );
    const promptSpy = vi.spyOn(window, 'prompt').mockReturnValue('t4-node-probe');
    try {
      renderNode('/nodes/node-1');
      fireEvent.click(await screen.findByRole('button', { name: /server is gone: remove node/i }));
      await waitFor(() => {
        expect(mocks.confirmNodeManualDeletion).toHaveBeenLastCalledWith('node-1', 't4-node-probe');
      });
      expect(mocks.confirmNodeManualDeletion).toHaveBeenNthCalledWith(1, 'node-1');
      expect(promptSpy).toHaveBeenCalledWith(expect.stringContaining('t4-node-probe'));
      expect(await screen.findByTestId('nodes-list-page')).toBeInTheDocument();
    } finally {
      promptSpy.mockRestore();
      auth.isSuperadmin = false;
    }
  });

  it('warns a deployment node owner about hosted environments before manual removal', async () => {
    mocks.getNode.mockResolvedValue({
      ...(await mocks.getNode()),
      status: 'destroying',
      nodeRole: 'deployment',
      cloudProvider: 'hetzner',
      deploymentEnvironments: [{ id: 'env-1', name: 'production' }],
    });
    confirmSpy.mockReturnValue(false);
    renderNode('/nodes/node-1');

    fireEvent.click(await screen.findByRole('button', { name: /i already deleted this server/i }));

    expect(confirmSpy).toHaveBeenLastCalledWith(
      expect.stringContaining('deployment node hosting 1 deployment environment: production')
    );
    expect(mocks.confirmNodeManualDeletion).not.toHaveBeenCalled();
  });

  it('keeps the node page and shows the server refusal when the provider still has the server', async () => {
    mocks.getNode.mockResolvedValue({
      ...(await mocks.getNode()),
      status: 'error',
      cloudProvider: 'hetzner',
    });
    mocks.confirmNodeManualDeletion.mockRejectedValue(
      new Error('Server 123 still exists at hetzner. Delete it there first, then try again.')
    );
    renderNode('/nodes/node-1');

    fireEvent.click(await screen.findByRole('button', { name: /i already deleted this server/i }));

    expect(await screen.findByText(/still exists at hetzner/i)).toBeInTheDocument();
    expect(screen.queryByTestId('nodes-list-page')).not.toBeInTheDocument();
  });

  it('does not offer manual removal for a running node', async () => {
    renderNode('/nodes/node-1');

    expect(await screen.findByRole('button', { name: /delete node/i })).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /i already deleted this server/i })
    ).not.toBeInTheDocument();
  });

  it('shows error with retry when events fail to load', async () => {
    mocks.listNodeEvents.mockRejectedValue(new Error('Network timeout'));

    renderNode('/nodes/node-1');

    await waitFor(() => {
      expect(screen.getAllByText('Node 1').length).toBeGreaterThanOrEqual(1);
    });

    // Should show the events error with retry button
    await waitFor(() => {
      expect(screen.getByText(/Failed to load events/)).toBeInTheDocument();
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
    expect(screen.queryByText(/Failed to load events/)).not.toBeInTheDocument();
  });

  it('optimistically shows node as stopping when stop is clicked', async () => {
    mocks.stopNode.mockReturnValue(new Promise(() => {}));

    renderNode('/nodes/node-1');

    await waitFor(() => {
      expect(screen.getAllByText('Node 1').length).toBeGreaterThanOrEqual(1);
    });

    fireEvent.click(screen.getByRole('button', { name: /stop node/i }));

    // Optimistic: stop button should show "Stopping..." text
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /^stopping\.\.\.$/i })).toBeInTheDocument();
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
