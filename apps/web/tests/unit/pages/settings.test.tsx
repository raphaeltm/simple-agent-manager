import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

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

import { Settings } from '../../../src/pages/Settings';

function renderSettings() {
  return render(
    <MemoryRouter>
      <Settings />
    </MemoryRouter>
  );
}

describe('Settings page', () => {
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

  it('renders all four settings sections', async () => {
    renderSettings();

    await waitFor(() => {
      expect(mocks.listCredentials).toHaveBeenCalled();
    });

    expect(screen.getByText('Hetzner Cloud')).toBeInTheDocument();
    expect(screen.getByText('GitHub App')).toBeInTheDocument();
    expect(screen.getByText('Agent API Keys')).toBeInTheDocument();
    expect(screen.getByText('Agent Settings')).toBeInTheDocument();
    expect(screen.getByTestId('hetzner-token-form')).toBeInTheDocument();
    expect(screen.getByTestId('github-app-section')).toBeInTheDocument();
    expect(screen.getByTestId('agent-keys-section')).toBeInTheDocument();
    expect(screen.getByTestId('agent-settings-section')).toBeInTheDocument();
  });

  it('shows hetzner credential as connected when present', async () => {
    renderSettings();

    await waitFor(() => {
      expect(screen.getByTestId('hetzner-token-form')).toHaveTextContent('connected');
    });
  });

  it('shows hetzner as not connected when no credential', async () => {
    mocks.listCredentials.mockResolvedValue([]);
    renderSettings();

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

  it('displays the agent settings description', async () => {
    renderSettings();

    await waitFor(() => {
      expect(screen.getByText(/Configure model selection and permission behavior/)).toBeInTheDocument();
    });
  });
});
