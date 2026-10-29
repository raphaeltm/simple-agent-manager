import { render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Navigate, Route, Routes, useLocation } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { accountRows, mergeRows } from '../components/accounts/fixtures';

const mocks = vi.hoisted(() => ({
  getResolutionStatus: vi.fn(),
  listCCCredentials: vi.fn(),
  listCCConfigurations: vi.fn(),
  listCCAttachments: vi.fn(),
  listProjects: vi.fn(),
  getMyCredentialLimits: vi.fn(),
  listAgents: vi.fn(),
  getAgentSettings: vi.fn(),
  listCredentials: vi.fn(),
}));

// `useQueryScope()` reads the authenticated identity, and every migrated query
// is keyed by it. Without a provider `useAuth` throws, so supply a stable identity.
vi.mock('../../../src/components/AuthProvider', () => ({
  useAuth: () => ({ user: { id: 'user-1', email: 'user@example.com', name: 'Test User' } }),
}));

vi.mock('../../../src/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/lib/api')>()),
  ...mocks,
}));

vi.mock('../../../src/components/SamSettingsCard', () => ({
  SamSettingsCard: () => <div data-testid="sam-settings-card" />,
}));

vi.mock('../../../src/components/AgentSettingsCard', () => ({
  AgentSettingsCard: ({ agent }: { agent: { id: string } }) => (
    <div data-testid={`agent-defaults-${agent.id}`} />
  ),
}));

vi.mock('../../../src/components/GcpCredentialForm', () => ({
  GcpCredentialForm: () => <div data-testid="gcp-credential-form" />,
}));

vi.mock('../../../src/components/GitHubAppSection', () => ({
  GitHubAppSection: () => <div data-testid="github-app-section">github-app</div>,
}));

vi.mock('../../../src/components/project-settings/DefaultCapacityPoolsPanel', () => ({
  DefaultCapacityPoolsPanel: () => <div data-testid="default-capacity-pools-panel" />,
}));

import { ToastProvider } from '../../../src/hooks/useToast';
import { Settings } from '../../../src/pages/Settings';
import {
  LegacyCloudProviderRedirect,
  SettingsRedirect,
} from '../../../src/pages/settings-redirects';
import { SettingsAgents } from '../../../src/pages/SettingsAgents';
import { SettingsGitHub } from '../../../src/pages/SettingsGitHub';
import { SettingsInfrastructure } from '../../../src/pages/SettingsInfrastructure';
import { QueryTestWrapper } from '../../test-utils/query-test-utils';

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{`${location.pathname}${location.search}`}</output>;
}

function renderSettings(path: string) {
  return render(
    <ToastProvider>
      <MemoryRouter initialEntries={[path]}>
        <LocationProbe />
        <Routes>
          <Route path="/settings" element={<Settings />}>
            <Route index element={<Navigate to="agents" replace />} />
            <Route path="agents" element={<SettingsAgents />} />
            <Route path="infrastructure" element={<SettingsInfrastructure />} />
            <Route path="github" element={<SettingsGitHub />} />
            <Route path="cloud-provider" element={<LegacyCloudProviderRedirect />} />
            <Route path="connections" element={<SettingsRedirect to="/settings/agents" />} />
          </Route>
        </Routes>
      </MemoryRouter>
    </ToastProvider>,
    { wrapper: QueryTestWrapper }
  );
}

const PROJECTS = [
  { id: 'p-web', name: 'Marketing site' },
  { id: 'p-client', name: 'Acme client portal' },
];

const ROWS = mergeRows(
  accountRows({
    id: 'work',
    name: 'Work Max plan',
    kind: 'agent',
    target: 'claude-code',
    credentialKind: 'oauth-token',
    isDefault: true,
  }),
  accountRows({
    id: 'acme',
    name: 'Acme API key',
    kind: 'agent',
    target: 'claude-code',
    pins: ['p-client'],
  }),
  accountRows({
    id: 'hz',
    name: 'Hetzner — Personal',
    kind: 'compute',
    target: 'hetzner',
    isDefault: true,
  })
);

describe('Settings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getResolutionStatus.mockResolvedValue({ consumers: [] });
    mocks.listCCCredentials.mockResolvedValue(ROWS.credentials);
    mocks.listCCConfigurations.mockResolvedValue(ROWS.configurations);
    mocks.listCCAttachments.mockResolvedValue(ROWS.attachments);
    mocks.listProjects.mockResolvedValue({ projects: PROJECTS, nextCursor: null });
    mocks.getMyCredentialLimits.mockResolvedValue({ credentials: [] });
    mocks.listAgents.mockResolvedValue({
      agents: [
        { id: 'claude-code', name: 'Claude Code', configured: true },
        { id: 'openai-codex', name: 'Codex', configured: false },
      ],
    });
    mocks.getAgentSettings.mockResolvedValue(null);
    mocks.listCredentials.mockResolvedValue([]);
  });

  it('lists every section in the sidebar and the mobile tab strip', async () => {
    renderSettings('/settings/agents');

    const nav = screen.getByRole('navigation', { name: 'Settings sections' });
    const labels = ['Agents', 'Infrastructure', 'GitHub', 'MCP servers', 'Notifications'];
    for (const label of [...labels, 'Usage', 'Access']) {
      expect(within(nav).getByRole('link', { name: label })).toBeInTheDocument();
      expect(screen.getByRole('tab', { name: label })).toBeInTheDocument();
    }
    expect(within(nav).getByRole('link', { name: 'Agents' })).toHaveAttribute(
      'href',
      '/settings/agents'
    );
    expect(screen.queryByRole('tab', { name: 'Cloud Provider' })).toBeNull();
    expect(screen.queryByRole('tab', { name: 'Connections' })).toBeNull();
    expect(await screen.findByRole('heading', { name: 'Agent accounts' })).toBeInTheDocument();
  });

  it('opens Agents from /settings', async () => {
    renderSettings('/settings');

    expect(await screen.findByRole('heading', { name: 'Agent accounts' })).toBeInTheDocument();
    expect(screen.getByTestId('location')).toHaveTextContent('/settings/agents');
  });

  it('redirects the former Connections tab to Agents', async () => {
    renderSettings('/settings/connections');

    expect(await screen.findByRole('heading', { name: 'Agent accounts' })).toBeInTheDocument();
    expect(screen.getByTestId('location')).toHaveTextContent(/^\/settings\/agents$/);
  });

  it('redirects the former Cloud Provider tab to Infrastructure', async () => {
    renderSettings('/settings/cloud-provider');

    expect(await screen.findByRole('heading', { name: 'Cloud accounts' })).toBeInTheDocument();
    expect(screen.getByTestId('location')).toHaveTextContent(/^\/settings\/infrastructure$/);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('reopens the Google Cloud connect step when the OAuth flow returns', async () => {
    renderSettings('/settings/cloud-provider?gcp_setup=ready');

    const dialog = await screen.findByRole('dialog', { name: 'Connect Google Cloud' });
    expect(screen.getByTestId('location')).toHaveTextContent(
      '/settings/infrastructure?gcp_setup=ready&connect=gcp'
    );
    expect(await within(dialog).findByTestId('gcp-credential-form')).toBeInTheDocument();
  });

  it('shows agent accounts by role with their projects, and per-agent defaults', async () => {
    renderSettings('/settings/agents');

    const row = await screen.findByTestId('provider-row-claude-code');
    // Each lane is headed by its role; the cards inside it carry no badge of their own.
    const lane = (role: string) =>
      within(row).getByRole('heading', { name: role }).parentElement!.parentElement!;
    const work = within(lane('Default')).getByTestId('account-card-cfg-work');
    expect(within(work).getByText('Work Max plan')).toBeInTheDocument();
    expect(within(work).queryByText('Default')).toBeNull();
    const acme = within(lane('Pinned')).getByTestId('account-card-cfg-acme');
    expect(within(acme).getByText('Acme API key')).toBeInTheDocument();
    // Nothing is unattached, so that lane is not shown at all.
    expect(within(row).queryByRole('heading', { name: 'Unattached' })).toBeNull();
    // The bar is decorative; its legend carries the same counts as text.
    expect(within(row).getByRole('button', { expanded: true })).toHaveTextContent(
      /Work Max plan\s*1.*Acme API key\s*1/
    );
    expect(within(row).getByRole('link', { name: 'Acme client portal' })).toHaveAttribute(
      'href',
      '/projects/p-client/settings/accounts'
    );
    // Codex has no account yet: a quick-connect chip, not a row.
    expect(screen.queryByTestId('provider-row-openai-codex')).toBeNull();
    expect(screen.getAllByRole('button', { name: /Codex/ }).length).toBeGreaterThan(0);

    expect(await screen.findByTestId('agent-defaults-claude-code')).toBeInTheDocument();
    expect(screen.queryByTestId('agent-defaults-openai-codex')).toBeNull();
    expect(screen.queryByTestId('provider-row-hetzner')).toBeNull();
  });

  it('shows cloud accounts and the node pool defaults on Infrastructure', async () => {
    renderSettings('/settings/infrastructure');

    const row = await screen.findByTestId('provider-row-hetzner');
    expect(within(row).getByTestId('account-card-cfg-hz')).toHaveAccessibleName(
      'Hetzner account Hetzner — Personal'
    );
    expect(screen.getByTestId('default-capacity-pools-panel')).toBeInTheDocument();
    expect(screen.queryByTestId('provider-row-claude-code')).toBeNull();
  });

  it('waits for the resolution-status backfill before listing accounts', async () => {
    let finishBackfill: (value: { consumers: [] }) => void = () => undefined;
    mocks.getResolutionStatus.mockReturnValue(
      new Promise((resolve) => {
        finishBackfill = resolve;
      })
    );
    renderSettings('/settings/agents');

    expect(await screen.findByRole('status', { name: 'Loading accounts' })).toBeInTheDocument();
    expect(mocks.listCCCredentials).not.toHaveBeenCalled();

    finishBackfill({ consumers: [] });
    expect(await screen.findByTestId('provider-row-claude-code')).toBeInTheDocument();
    expect(mocks.listCCCredentials).toHaveBeenCalledTimes(1);
  });

  it('shows a retryable error when the accounts cannot load', async () => {
    mocks.listCCCredentials.mockRejectedValueOnce(new Error('Accounts unavailable'));
    renderSettings('/settings/agents');

    expect(await screen.findByText('Accounts unavailable')).toBeInTheDocument();
    screen.getByRole('button', { name: 'Retry' }).click();
    await waitFor(() => expect(screen.getByTestId('provider-row-claude-code')).toBeVisible());
  });

  it('renders the GitHub section', async () => {
    renderSettings('/settings/github');

    expect(await screen.findByTestId('github-app-section')).toBeInTheDocument();
  });
});
