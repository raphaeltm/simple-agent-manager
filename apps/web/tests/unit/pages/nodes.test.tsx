import { fireEvent, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWithQuery } from '../../test-utils/query-test-utils';

const mocks = vi.hoisted(() => ({
  listNodes: vi.fn(),
  listWorkspaces: vi.fn(),
  createNode: vi.fn(),
  getProviderCatalog: vi.fn(),
}));

vi.mock('../../../src/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/lib/api')>()),
  listNodes: mocks.listNodes,
  listWorkspaces: mocks.listWorkspaces,
  createNode: mocks.createNode,
  getProviderCatalog: mocks.getProviderCatalog,
}));

vi.mock('../../../src/components/UserMenu', () => ({
  UserMenu: () => <div data-testid="user-menu" />,
}));

import { Nodes } from '../../../src/pages/Nodes';

describe('Nodes page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listNodes.mockResolvedValue([
      {
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
      },
    ]);
    mocks.listWorkspaces.mockResolvedValue([]);
    mocks.createNode.mockResolvedValue({
      id: 'node-2',
      name: 'Node 2',
      status: 'creating',
      healthStatus: 'stale',
      vmSize: 'medium',
      vmLocation: 'nbg1',
      ipAddress: null,
      lastHeartbeatAt: null,
      heartbeatStaleAfterSeconds: 180,
      errorMessage: null,
      createdAt: '2026-01-02T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
    });
    mocks.getProviderCatalog.mockResolvedValue({ catalogs: [] });
  });

  it('renders node list', async () => {
    renderWithQuery(
      <MemoryRouter>
        <Nodes />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(mocks.listNodes).toHaveBeenCalled();
    });

    expect(await screen.findByText('Node 1')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /create node/i })).toBeInTheDocument();
  });

  it('supports create-node flow and navigates to node detail', async () => {
    renderWithQuery(
      <MemoryRouter initialEntries={['/nodes']}>
        <Routes>
          <Route path="/nodes" element={<Nodes />} />
          <Route path="/nodes/:id" element={<div data-testid="node-detail-page">Node Detail</div>} />
        </Routes>
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(mocks.listNodes).toHaveBeenCalled();
    });

    // Click "Create Node" to open the form (header button toggles to "Cancel")
    fireEvent.click(screen.getByRole('button', { name: /create node/i }));

    // The form is now visible; click the "Create Node" submit button inside it
    fireEvent.click(screen.getByRole('button', { name: /create node/i }));

    await waitFor(() => {
      expect(mocks.createNode).toHaveBeenCalledTimes(1);
      expect(mocks.createNode).toHaveBeenCalledWith({
        name: expect.stringMatching(/^node-[0-9]{14}$/),
        vmSize: 'medium',
        vmLocation: 'nbg1',
      });
    });

    expect(await screen.findByTestId('node-detail-page')).toBeInTheDocument();
  });

  it('keeps stale node list visible during background refetch', async () => {
    // First load
    mocks.listNodes.mockResolvedValue([
      {
        id: 'node-1',
        name: 'Stale Node',
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
      },
    ]);

    const { queryClient } = renderWithQuery(
      <MemoryRouter>
        <Nodes />
      </MemoryRouter>
    );

    // Wait for initial data
    expect(await screen.findByText('Stale Node')).toBeInTheDocument();

    // Set up a slow second fetch to simulate background refetch
    let resolveRefetch: (value: unknown) => void;
    const refetchPromise = new Promise((resolve) => {
      resolveRefetch = resolve;
    });
    mocks.listNodes.mockReturnValueOnce(refetchPromise);

    // Trigger a refetch
    void queryClient.invalidateQueries({ queryKey: ['nodes'] });

    // Content must stay visible while refetch is in-flight
    expect(screen.getByText('Stale Node')).toBeInTheDocument();

    // Resolve with updated data
    resolveRefetch!([
      {
        id: 'node-1',
        name: 'Fresh Node',
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
      },
    ]);

    // Eventually the new data replaces the stale data
    await waitFor(() => {
      expect(screen.getByText('Fresh Node')).toBeInTheDocument();
    });
  });
});
