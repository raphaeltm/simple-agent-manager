import type {
  NodeResourceUsageResponse,
  NodeResponse,
  NodeWorkspaceResourceUsage,
  SafeEffectiveCapacityPoolSummary,
} from '@simple-agent-manager/shared';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWithQuery } from '../../test-utils/query-test-utils';

const mocks = vi.hoisted(() => ({
  listNodes: vi.fn(),
  getNodeResourceUsage: vi.fn(),
  createNode: vi.fn(),
  stopNode: vi.fn(),
  deleteNode: vi.fn(),
  getProviderCatalog: vi.fn(),
  fetchUserDefaultCapacityPools: vi.fn(),
}));

// `useQueryScope()` reads the authenticated identity, and every migrated query
// is keyed by it. Without a provider `useAuth` throws, so supply a stable identity.
vi.mock('../../../src/components/AuthProvider', () => ({
  useAuth: () => ({ user: { id: 'user-1', email: 'user@example.com', name: 'Test User' } }),
}));

vi.mock('../../../src/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/lib/api')>()),
  listNodes: mocks.listNodes,
  getNodeResourceUsage: mocks.getNodeResourceUsage,
  createNode: mocks.createNode,
  stopNode: mocks.stopNode,
  deleteNode: mocks.deleteNode,
  getProviderCatalog: mocks.getProviderCatalog,
}));

vi.mock('../../../src/components/UserMenu', () => ({
  UserMenu: () => <div data-testid="user-menu" />,
}));

vi.mock('../../../src/lib/api/capacity-pools', () => ({
  fetchUserDefaultCapacityPools: mocks.fetchUserDefaultCapacityPools,
}));

import { nodeQueryKeys } from '../../../src/lib/query-options';
import { Nodes } from '../../../src/pages/Nodes';

/** Must match the id returned by the mocked `useAuth` above — the query keys are
 * scoped by it, so an invalidate with a different scope would match nothing. */
const SCOPE = 'user-1';
const MINUTE = 60_000;
const GB = 1024 * 1024 * 1024;

function node(overrides: Partial<NodeResponse> = {}): NodeResponse {
  return {
    id: 'node-1',
    name: 'Node 1',
    status: 'running',
    healthStatus: 'healthy',
    vmSize: 'medium',
    vmLocation: 'nbg1',
    nodeRole: 'workspace',
    ipAddress: '1.1.1.1',
    lastHeartbeatAt: '2026-01-01T00:00:00.000Z',
    heartbeatStaleAfterSeconds: 180,
    errorMessage: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function usageResponse(
  workspaces: NodeWorkspaceResourceUsage[],
  now = Date.now()
): NodeResourceUsageResponse {
  return {
    windowMinutes: 60,
    windowStart: now - 60 * MINUTE,
    windowEnd: now,
    bucketMs: MINUTE,
    workspaces,
  };
}

/** Ten history minutes ending 20 minutes ago, as a 15-minute upload would leave them. */
function session(
  overrides: Partial<NodeWorkspaceResourceUsage> & { memoryGb?: number; cpuMillis?: number } = {}
): NodeWorkspaceResourceUsage {
  const { memoryGb = 2, cpuMillis = 500, ...rest } = overrides;
  const end = Date.now() - 20 * MINUTE;
  const start = Array.from({ length: 10 }, (_, i) => end - (10 - i) * MINUTE);
  return {
    workspaceId: 'ws-1',
    nodeId: 'node-1',
    projectId: 'proj-1',
    projectName: 'SAM',
    chatSessionId: 'chat-1',
    title: 'Fix the OOM relocation',
    ownerUserId: 'user-1',
    ownerName: 'Test User',
    isMine: true,
    status: 'running',
    createdAt: new Date(Date.now() - 90 * MINUTE).toISOString(),
    reservation: { cpuMillis: 1000, memoryMb: 4096, diskMb: 10240, exclusiveNode: false },
    series: {
      start,
      cpuMillis: start.map(() => cpuMillis),
      memoryBytes: start.map(() => memoryGb * GB),
    },
    historyEndsAt: end,
    ...rest,
  };
}

function renderPage() {
  return renderWithQuery(
    <MemoryRouter initialEntries={['/nodes']}>
      <Routes>
        <Route path="/nodes" element={<Nodes />} />
        <Route path="/nodes/:id" element={<div data-testid="node-detail-page">Node Detail</div>} />
        <Route
          path="/projects/:projectId/chat/:sessionId"
          element={<div data-testid="chat-page">Chat</div>}
        />
      </Routes>
    </MemoryRouter>
  );
}

describe('Nodes page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listNodes.mockResolvedValue([node()]);
    mocks.getNodeResourceUsage.mockResolvedValue(usageResponse([]));
    mocks.stopNode.mockResolvedValue({ status: 'stopping' });
    mocks.deleteNode.mockResolvedValue({ success: true });
    mocks.createNode.mockResolvedValue(
      node({
        id: 'node-2',
        name: 'Node 2',
        status: 'creating',
        healthStatus: 'stale',
        ipAddress: null,
      })
    );
    mocks.getProviderCatalog.mockResolvedValue({ catalogs: [] });
    // An installation-funded user has no personal credential catalog. Creation
    // uses the safe native offerings from the authoritative effective pool.
    const effectiveSummary: SafeEffectiveCapacityPoolSummary = {
      scope: 'installation',
      state: 'configured-ready',
      strategy: 'pack',
      exhaustionPolicy: 'fail',
      availableCandidateCount: 2,
      nativeOfferings: [
        {
          provider: 'hetzner',
          location: 'nbg1',
          providerInstanceType: 'cx23',
          displayName: 'CX23',
          vcpu: 2,
          memoryMb: 4096,
          diskGb: 40,
          price: '€4/month',
        },
        {
          provider: 'hetzner',
          location: 'nbg1',
          providerInstanceType: 'cx43',
          displayName: 'CX43',
          vcpu: 8,
          memoryMb: 16384,
          diskGb: 160,
          price: '€16/month',
        },
      ],
    };
    mocks.fetchUserDefaultCapacityPools.mockResolvedValue({ effectiveSummary });
  });

  it('renders node list', async () => {
    renderPage();
    expect(await screen.findByRole('heading', { name: 'Node 1' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /create node/i })).toBeInTheDocument();
  });

  it('names a machine by its hardware, not by the task that started it', async () => {
    mocks.listNodes.mockResolvedValue([
      node({
        name: 'Auto: Review previous session context using SA',
        cloudProvider: 'hetzner',
        providerInstanceType: 'cx43',
        providerInstanceVcpuCount: 8,
        providerInstanceMemoryMb: 16384,
        providerInstanceDiskGb: 160,
      }),
    ]);
    renderPage();
    const pane = await screen.findByRole('article', { name: /Hetzner cx43/ });
    expect(within(pane).getByRole('heading', { name: 'Hetzner cx43' })).toBeInTheDocument();
    expect(within(pane).getByText(/8 vCPU · 16 GB · 160 GB disk/)).toBeInTheDocument();
    // The task-derived name is only under Advanced.
    expect(
      screen.queryByRole('heading', { name: /Review previous session/ })
    ).not.toBeInTheDocument();
  });

  it('lists each session on its machine with a link to its chat and reserved vs used numbers', async () => {
    mocks.getNodeResourceUsage.mockResolvedValue(usageResponse([session()]));
    renderPage();

    const link = await screen.findByRole('link', { name: 'Fix the OOM relocation' });
    expect(link).toHaveAttribute('href', '/projects/proj-1/chat/chat-1');
    expect(screen.getByText('SAM')).toBeInTheDocument();
    expect(
      screen.getByLabelText(
        /Memory 2\.0 GB of 4\.0 GB set aside , CPU 0\.5 vCPU of 1\.0 vCPU set aside/
      )
    ).toBeInTheDocument();
    expect(screen.getByTestId('machine-chart')).toBeInTheDocument();

    await userEvent.setup().click(link);
    expect(await screen.findByTestId('chat-page')).toBeInTheDocument();
  });

  it('keeps workspace links under Advanced', async () => {
    mocks.getNodeResourceUsage.mockResolvedValue(usageResponse([session()]));
    renderPage();
    await screen.findByRole('link', { name: 'Fix the OOM relocation' });

    const workspaceLink = screen.getByRole('link', { name: /Workspace ws-1/i, hidden: true });
    expect(workspaceLink).toHaveAttribute('href', '/workspaces/ws-1');
    expect(workspaceLink.closest('details')).not.toBeNull();
  });

  it('uses live heartbeat memory for "now" when it is fresh, and history when it is stale', async () => {
    const fresh = new Date().toISOString();
    mocks.listNodes.mockResolvedValue([
      node({
        lastHeartbeatAt: fresh,
        lastMetrics: {
          workspaceMemory: [{ workspaceId: 'ws-1', memoryUsageBytes: 3 * GB, collectedAt: fresh }],
        },
      }),
    ]);
    mocks.getNodeResourceUsage.mockResolvedValue(usageResponse([session({ memoryGb: 2 })]));
    const { unmount } = renderPage();
    expect(await screen.findByLabelText(/Memory 3\.0 GB of 4\.0 GB set aside/)).toBeInTheDocument();
    expect(screen.getAllByTestId('live-memory-dot').length).toBeGreaterThan(0);
    unmount();

    const stale = new Date(Date.now() - 10 * MINUTE).toISOString();
    mocks.listNodes.mockResolvedValue([
      node({
        lastHeartbeatAt: stale,
        lastMetrics: {
          workspaceMemory: [{ workspaceId: 'ws-1', memoryUsageBytes: 3 * GB, collectedAt: stale }],
        },
      }),
    ]);
    renderPage();
    // Liveness: the row rendered, with the history value instead of the stale heartbeat.
    expect(await screen.findByLabelText(/Memory 2\.0 GB of 4\.0 GB set aside/)).toBeInTheDocument();
    expect(screen.queryByTestId('live-memory-dot')).not.toBeInTheDocument();
  });

  it('flags memory over its reservation as a problem but CPU over its reservation as fine', async () => {
    mocks.getNodeResourceUsage.mockResolvedValue(
      usageResponse([
        session({ workspaceId: 'mem', title: 'Memory hog', memoryGb: 5 }),
        session({
          workspaceId: 'cpu',
          title: 'CPU burst',
          chatSessionId: 'chat-2',
          cpuMillis: 1500,
        }),
      ])
    );
    renderPage();
    const memoryRow = (await screen.findByRole('link', { name: 'Memory hog' })).closest('li');
    const cpuRow = screen.getByRole('link', { name: 'CPU burst' }).closest('li');
    expect(within(memoryRow as HTMLElement).getByText('over limit')).toBeInTheDocument();
    expect(within(cpuRow as HTMLElement).getByText('burst, fine')).toBeInTheDocument();
    expect(within(cpuRow as HTMLElement).queryByText('over limit')).not.toBeInTheDocument();
  });

  it('shows an empty machine as idle, and a usage failure without hiding the machines', async () => {
    mocks.getNodeResourceUsage.mockRejectedValue(new Error('usage boom'));
    renderPage();
    expect(
      await screen.findByText(/Couldn.t load sessions and usage: usage boom/)
    ).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Node 1' })).toBeInTheDocument();
  });

  it('says nothing is running on a machine with no sessions', async () => {
    renderPage();
    expect(await screen.findByText(/Nothing running/)).toBeInTheDocument();
  });

  it('stops and deletes a node from its actions menu', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('heading', { name: 'Node 1' });

    await user.click(screen.getByRole('button', { name: /actions for node 1/i }));
    await user.click(screen.getByRole('menuitem', { name: 'Stop' }));
    await waitFor(() => expect(mocks.stopNode).toHaveBeenCalledWith('node-1'));

    await user.click(screen.getByRole('button', { name: /actions for node 1/i }));
    await user.click(screen.getByRole('menuitem', { name: 'Delete' }));
    await waitFor(() => expect(mocks.deleteNode).toHaveBeenCalledWith('node-1'));
  });

  it('links to the node detail page', async () => {
    renderPage();
    await screen.findByRole('heading', { name: 'Node 1' });
    fireEvent.click(screen.getByRole('link', { name: /details/i }));
    expect(await screen.findByTestId('node-detail-page')).toBeInTheDocument();
  });

  it('supports create-node flow and navigates to node detail', async () => {
    renderPage();
    await waitFor(() => {
      expect(mocks.listNodes).toHaveBeenCalled();
    });

    // Click "Create Node" to open the form (header button toggles to "Cancel")
    fireEvent.click(screen.getByRole('button', { name: /create node/i }));

    const offering = await screen.findByLabelText('Native offering');
    const submit = screen.getByRole('button', { name: /create node/i });
    expect(submit).toBeDisabled();
    expect(mocks.createNode).not.toHaveBeenCalled();
    fireEvent.change(offering, { target: { value: 'cx43' } });
    expect(screen.getByLabelText('Selected offering resources')).toHaveTextContent(
      '8 vCPU · 16 GB memory · 160 GB disk'
    );
    expect(submit).toBeEnabled();
    fireEvent.click(submit);

    await waitFor(() => {
      expect(mocks.createNode).toHaveBeenCalledTimes(1);
      expect(mocks.createNode).toHaveBeenCalledWith({
        name: expect.stringMatching(/^node-[0-9]{14}$/),
        provider: 'hetzner',
        providerInstanceType: 'cx43',
        vmLocation: 'nbg1',
      });
    });

    expect(await screen.findByTestId('node-detail-page')).toBeInTheDocument();
  });

  it('surfaces load error instead of empty state when initial load fails', async () => {
    // Regression: a failed initial load left nodesLoading=false with no data, so
    // the render gate fell through to the "No nodes yet" empty state — telling the
    // user they have zero nodes when the request actually errored.
    mocks.listNodes.mockRejectedValue(new Error('Nodes network error'));
    renderPage();
    expect(await screen.findByText('Nodes network error')).toBeInTheDocument();
    expect(screen.queryByText('No nodes yet')).not.toBeInTheDocument();
  });

  it('falls back to a friendly message when the load error has no message', async () => {
    mocks.listNodes.mockRejectedValue(new Error(''));
    renderPage();
    expect(await screen.findByText('Failed to load nodes')).toBeInTheDocument();
    expect(screen.queryByText('No nodes yet')).not.toBeInTheDocument();
  });

  it('keeps stale nodes visible when a background refetch fails (does not show error)', async () => {
    mocks.listNodes.mockResolvedValue([node({ name: 'Persisted Node' })]);
    const { queryClient } = renderPage();
    expect(await screen.findByRole('heading', { name: 'Persisted Node' })).toBeInTheDocument();

    mocks.listNodes.mockRejectedValueOnce(new Error('Nodes refetch boom'));
    void queryClient.invalidateQueries({ queryKey: nodeQueryKeys.all(SCOPE) });

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Persisted Node' })).toBeInTheDocument();
    });
    expect(screen.queryByText('Nodes refetch boom')).not.toBeInTheDocument();
    expect(screen.queryByText('No nodes yet')).not.toBeInTheDocument();
  });

  it('keeps stale node list visible during background refetch', async () => {
    mocks.listNodes.mockResolvedValue([node({ name: 'Stale Node' })]);
    const { queryClient } = renderPage();
    expect(await screen.findByRole('heading', { name: 'Stale Node' })).toBeInTheDocument();

    let resolveRefetch: (value: unknown) => void = () => {};
    mocks.listNodes.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveRefetch = resolve;
      })
    );
    void queryClient.invalidateQueries({ queryKey: nodeQueryKeys.all(SCOPE) });

    // Content must stay visible while refetch is in-flight
    expect(screen.getByRole('heading', { name: 'Stale Node' })).toBeInTheDocument();

    resolveRefetch([node({ name: 'Fresh Node' })]);
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Fresh Node' })).toBeInTheDocument();
    });
  });
});
