import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Navigate, Route, Routes } from 'react-router-dom';

const mocks = vi.hoisted(() => ({
  listCredentials: vi.fn(),
}));

vi.mock('../../../src/lib/api', () => ({
  listCredentials: mocks.listCredentials,
}));

vi.mock('../../../src/components/HetznerTokenForm', () => ({
  HetznerTokenForm: ({ credential }: { credential: unknown }) => (
    <div data-testid="hetzner-token-form">{credential ? 'connected' : 'not-connected'}</div>
  ),
}));

vi.mock('../../../src/components/GitHubAppSection', () => ({
  GitHubAppSection: () => <div data-testid="github-app-section">github-app</div>,
}));

vi.mock('../../../src/components/AgentKeysSection', () => ({
  AgentKeysSection: () => <div data-testid="agent-keys-section">agent-keys</div>,
}));

vi.mock('../../../src/components/AgentSettingsSection', () => ({
  AgentSettingsSection: () => <div data-testid="agent-settings-section">agent-settings</div>,
}));

vi.mock('../../../src/components/UserMenu', () => ({
  UserMenu: () => <div data-testid="user-menu">user-menu</div>,
}));

import { Settings } from '../../../src/pages/Settings';
import { SettingsCloudProvider } from '../../../src/pages/SettingsCloudProvider';
import { SettingsGitHub } from '../../../src/pages/SettingsGitHub';
import { SettingsAgentKeys } from '../../../src/pages/SettingsAgentKeys';
import { SettingsAgentConfig } from '../../../src/pages/SettingsAgentConfig';

function renderSettings(path = '/settings/cloud-provider') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/settings" element={<Settings />}>
          <Route index element={<Navigate to="cloud-provider" replace />} />
          <Route path="cloud-provider" element={<SettingsCloudProvider />} />
          <Route path="github" element={<SettingsGitHub />} />
          <Route path="agent-keys" element={<SettingsAgentKeys />} />
          <Route path="agent-config" element={<SettingsAgentConfig />} />
        </Route>
      </Routes>
    </MemoryRouter>
  );
}

describe('Settings shell', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listCredentials.mockResolvedValue([
      {
        id: 'cred_01',
        provider: 'hetzner',
        connected: true,
        createdAt: '2026-02-07T00:00:00.000Z',
      },
    ]);
  });

  it('renders 4 tabs in the settings shell', async () => {
    renderSettings();

    await waitFor(() => {
      expect(mocks.listCredentials).toHaveBeenCalled();
    });

    expect(screen.getByRole('tab', { name: 'Cloud Provider' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'GitHub' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Agent Keys' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Agent Config' })).toBeInTheDocument();
  });

  it('renders breadcrumb with Dashboard link', async () => {
    renderSettings();

    await waitFor(() => {
      expect(mocks.listCredentials).toHaveBeenCalled();
    });

    expect(screen.getByRole('link', { name: 'Dashboard' })).toHaveAttribute('href', '/dashboard');
    expect(screen.getByRole('heading', { name: 'Settings' })).toBeInTheDocument();
  });

  it('renders cloud-provider sub-route with hetzner form', async () => {
    renderSettings('/settings/cloud-provider');

    await waitFor(() => {
      expect(screen.getByTestId('hetzner-token-form')).toHaveTextContent('connected');
    });
  });

  it('renders github sub-route', async () => {
    renderSettings('/settings/github');

    await waitFor(() => {
      expect(mocks.listCredentials).toHaveBeenCalled();
    });

    expect(screen.getByTestId('github-app-section')).toBeInTheDocument();
  });

  it('renders agent-keys sub-route', async () => {
    renderSettings('/settings/agent-keys');

    await waitFor(() => {
      expect(mocks.listCredentials).toHaveBeenCalled();
    });

    expect(screen.getByTestId('agent-keys-section')).toBeInTheDocument();
  });

  it('renders agent-config sub-route', async () => {
    renderSettings('/settings/agent-config');

    await waitFor(() => {
      expect(mocks.listCredentials).toHaveBeenCalled();
    });

    expect(screen.getByTestId('agent-settings-section')).toBeInTheDocument();
  });

  it('shows hetzner as not connected when no credential', async () => {
    mocks.listCredentials.mockResolvedValue([]);
    renderSettings('/settings/cloud-provider');

    await waitFor(() => {
      expect(screen.getByTestId('hetzner-token-form')).toHaveTextContent('not-connected');
    });
  });

  it('shows error alert on credentials load failure', async () => {
    mocks.listCredentials.mockRejectedValue(new Error('Load failed'));
    renderSettings();

    await waitFor(() => {
      expect(screen.getByText('Load failed')).toBeInTheDocument();
    });
  });
});
