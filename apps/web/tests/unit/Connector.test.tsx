import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render as rtlRender, screen, waitFor } from '@testing-library/react';
import type { ReactElement } from 'react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  userId: 'user-1',
  get: vi.fn(),
  decide: vi.fn(),
  connections: vi.fn(),
  revoke: vi.fn(),
  settings: vi.fn(),
  admin: vi.fn(),
  save: vi.fn(),
  clients: vi.fn(),
  block: vi.fn(),
}));
vi.mock('../../src/components/AuthProvider', () => ({
  useAuth: () => ({ user: { id: mocks.userId }, isAuthenticated: true, isLoading: false }),
}));
vi.mock('../../src/hooks/useLoginProviders', () => ({
  useLoginProviders: () => ({ github: true }),
}));
vi.mock('../../src/components/ApiTokens', () => ({
  ApiTokens: () => <div>Existing API tokens</div>,
}));
vi.mock('../../src/lib/api/connector', () => ({
  getConnectorConsent: mocks.get,
  decideConnectorConsent: mocks.decide,
  connectorConnections: mocks.connections,
  revokeConnectorConnection: mocks.revoke,
  connectorSettings: mocks.settings,
  adminConnectorSettings: mocks.admin,
  saveConnectorSettings: mocks.save,
  connectorClients: mocks.clients,
  blockConnectorClient: mocks.block,
}));
import { AdminConnectorPanel } from '../../src/components/AdminConnectorPanel';
import { ConnectorConnections } from '../../src/components/ConnectorConnections';
import { ConnectorConsent } from '../../src/pages/ConnectorConsent';
import { SettingsApiTokens } from '../../src/pages/SettingsApiTokens';
let queryClient: QueryClient;
function render(ui: ReactElement) {
  return rtlRender(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}
const connection = {
  id: 'grant-1',
  clientName: 'Claude',
  scopes: ['sam.read'],
  createdAt: '2026-10-09T00:00:00Z',
  lastUsedAt: null,
  revokedAt: null,
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.userId = 'user-1';
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  mocks.connections.mockResolvedValue({ connections: [] });
  mocks.settings.mockResolvedValue({
    enabled: true,
    writeEnabled: true,
    url: 'https://api.example.com/connect/mcp',
  });
});
describe('Connector consent and access', () => {
  it('shows redirect host, plain scopes and loopback warning; deny uses the bound handle', async () => {
    mocks.get.mockResolvedValue({
      handle: 'bound-handle',
      clientName: 'Local app',
      redirectHost: 'localhost:9000',
      loopback: true,
      scopes: ['sam.read', 'sam.write', 'offline_access'],
    });
    mocks.decide.mockRejectedValue(new Error('Try again'));
    render(
      <MemoryRouter initialEntries={['/oauth/consent?request=client_id%3Dtest']}>
        <ConnectorConsent />
      </MemoryRouter>
    );
    expect(await screen.findByText('localhost:9000')).toBeInTheDocument();
    expect(screen.getByText('Start, steer, and stop work as you')).toBeInTheDocument();
    expect(screen.getByText(/local program on this device/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Deny' }));
    await waitFor(() => expect(mocks.decide).toHaveBeenCalledWith('bound-handle', false));
    expect(await screen.findByText('Try again')).toBeInTheDocument();
    expect(mocks.get).toHaveBeenCalledTimes(1);
  });
  it('approves explicitly and preserves the loaded consent when submission fails', async () => {
    mocks.get.mockResolvedValue({
      handle: 'approve-handle',
      clientName: 'Claude',
      redirectHost: 'claude.ai',
      loopback: false,
      scopes: ['sam.read'],
    });
    mocks.decide.mockRejectedValue(new Error('Network unavailable'));
    render(
      <MemoryRouter initialEntries={['/oauth/consent?request=client_id%3Dtest']}>
        <ConnectorConsent />
      </MemoryRouter>
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(mocks.decide).toHaveBeenCalledWith('approve-handle', true));
    expect(await screen.findByText('Network unavailable')).toBeInTheDocument();
    expect(screen.getByText('claude.ai')).toBeInTheDocument();
    expect(mocks.get).toHaveBeenCalledTimes(1);
  });
  it('admits only one pending load-more request', async () => {
    let finish!: (value: { connections: (typeof connection)[]; nextCursor: null }) => void;
    mocks.connections
      .mockResolvedValueOnce({ connections: [connection], nextCursor: 'page-2' })
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          })
      );
    render(<ConnectorConnections />);
    const more = await screen.findByRole('button', { name: 'Load more connections' });
    fireEvent.click(more);
    fireEvent.click(more);
    expect(mocks.connections).toHaveBeenCalledTimes(2);
    expect(await screen.findByRole('button', { name: 'Loading connections…' })).toBeDisabled();
    finish({
      connections: [{ ...connection, id: 'grant-2', clientName: 'ChatGPT' }],
      nextCursor: null,
    });
    expect(await screen.findByText('ChatGPT')).toBeInTheDocument();
    expect(screen.getAllByText('Claude')).toHaveLength(1);
  });
  it('requires confirmation before revoking and refreshes the list after success', async () => {
    mocks.connections
      .mockResolvedValueOnce({ connections: [connection] })
      .mockResolvedValue({ connections: [] });
    mocks.revoke.mockResolvedValue(undefined);
    render(<ConnectorConnections />);
    fireEvent.click(await screen.findByRole('button', { name: 'Revoke' }));
    expect(mocks.revoke).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Revoke access' }));
    await waitFor(() => expect(mocks.revoke).toHaveBeenCalledWith('grant-1', false));
    expect(await screen.findByText('No connected apps.')).toBeInTheDocument();
  });
  it('loads subsequent connection pages without replacing earlier grants', async () => {
    mocks.connections
      .mockResolvedValueOnce({ connections: [connection], nextCursor: 'page-2' })
      .mockResolvedValueOnce({
        connections: [{ ...connection, id: 'grant-2', clientName: 'ChatGPT' }],
        nextCursor: null,
      });
    render(<ConnectorConnections />);
    fireEvent.click(await screen.findByRole('button', { name: 'Load more connections' }));
    expect(await screen.findByText('ChatGPT')).toBeInTheDocument();
    expect(screen.getByText('Claude')).toBeInTheDocument();
    expect(mocks.connections).toHaveBeenLastCalledWith(false, 'page-2');
  });
  it('hides connect instructions when disabled while preserving API tokens and revocation', async () => {
    mocks.settings.mockResolvedValue({
      enabled: false,
      writeEnabled: false,
      url: 'https://api.example.com/connect/mcp',
    });
    render(<SettingsApiTokens />);
    expect(await screen.findByText('No connected apps.')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Connect an AI app' })).not.toBeInTheDocument();
    expect(screen.getByText('Existing API tokens')).toBeInTheDocument();
  });
  it('retains edited admin settings until explicit save and supports blocking a client', async () => {
    const settings = {
      enabled: { value: true, source: 'default', updatedAt: null, updatedBy: null },
      writeEnabled: { value: true, source: 'environment', updatedAt: null, updatedBy: null },
    };
    mocks.admin.mockResolvedValue({ settings });
    mocks.save.mockResolvedValue({ settings });
    const clientList = {
      clients: [
        {
          id: 'client-1',
          clientName: 'App',
          redirectHosts: ['example.com'],
          createdAt: '2026-10-09',
          blocked: false,
        },
      ],
    };
    mocks.clients.mockResolvedValueOnce(clientList).mockResolvedValue({
      ...clientList,
      clients: clientList.clients.map((c) => ({ ...c, blocked: true })),
    });
    mocks.block.mockResolvedValue(undefined);
    render(<AdminConnectorPanel />);
    fireEvent.click(await screen.findByLabelText('Enable Connector'));
    expect(screen.getByLabelText('Enable Connector')).not.toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: 'Save Connector settings' }));
    await waitFor(() => expect(mocks.save).toHaveBeenCalledWith({ enabled: false }));
    fireEvent.click(screen.getByRole('button', { name: 'Block' }));
    expect(await screen.findByRole('button', { name: 'Unblock' })).toBeInTheDocument();
    expect(mocks.block).toHaveBeenCalledWith('client-1', true);
    expect(mocks.admin).toHaveBeenCalledTimes(1);
  });
  it('does not overwrite dirty edits on background refresh and resets only the selected override', async () => {
    const settings = {
      enabled: { value: true, source: 'runtime', updatedAt: '2026-10-09', updatedBy: 'admin' },
      writeEnabled: { value: true, source: 'environment', updatedAt: null, updatedBy: null },
    };
    mocks.admin.mockResolvedValue({ settings });
    mocks.clients.mockResolvedValue({ clients: [] });
    render(<AdminConnectorPanel />);
    expect(await screen.findByRole('button', { name: 'Save Connector settings' })).toBeDisabled();
    fireEvent.click(screen.getByLabelText('Allow writes'));
    await act(async () => {
      await queryClient.invalidateQueries({
        queryKey: ['auth', 'user-1', 'connector', 'admin-settings'],
      });
    });
    expect(screen.getByLabelText('Allow writes')).not.toBeChecked();
    mocks.save.mockResolvedValue({
      settings: {
        ...settings,
        enabled: { value: false, source: 'environment', updatedAt: null, updatedBy: null },
      },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Reset Enable Connector to default' }));
    await waitFor(() => expect(mocks.save).toHaveBeenCalledWith({ enabled: null }));
    expect(
      await screen.findByText('Override removed. The installation default is active.')
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Allow writes')).not.toBeChecked();
    expect(
      screen.queryByRole('button', { name: 'Reset Enable Connector to default' })
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save Connector settings' }));
    await waitFor(() => expect(mocks.save).toHaveBeenLastCalledWith({ writeEnabled: false }));
  });

  it('does not reuse another account’s cached connections', async () => {
    mocks.connections
      .mockResolvedValueOnce({ connections: [connection] })
      .mockResolvedValueOnce({ connections: [] });
    const first = render(<ConnectorConnections />);
    expect(await screen.findByText('Claude')).toBeInTheDocument();
    first.unmount();
    mocks.userId = 'user-2';
    render(<ConnectorConnections />);
    expect(screen.queryByText('Claude')).not.toBeInTheDocument();
    expect(await screen.findByText('No connected apps.')).toBeInTheDocument();
    expect(mocks.connections).toHaveBeenCalledTimes(2);
  });
});
