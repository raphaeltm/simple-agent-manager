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

  it('renders all three settings sections', async () => {
    renderSettings();

    await waitFor(() => {
      expect(mocks.listCredentials).toHaveBeenCalled();
    });

    expect(screen.getByText('Hetzner Cloud')).toBeInTheDocument();
    expect(screen.getByText('GitHub App')).toBeInTheDocument();
    expect(screen.getByText('Agent API Keys')).toBeInTheDocument();
    expect(screen.getByTestId('hetzner-token-form')).toBeInTheDocument();
    expect(screen.getByTestId('github-app-section')).toBeInTheDocument();
    expect(screen.getByTestId('agent-keys-section')).toBeInTheDocument();
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

  it('shows error alert when credentials fail to load', async () => {
    mocks.listCredentials.mockRejectedValue(new Error('Network error'));
    renderSettings();

    await waitFor(() => {
      expect(screen.getByText('Network error')).toBeInTheDocument();
    });
  });

  it('does not render governance sections', async () => {
    renderSettings();

    await waitFor(() => {
      expect(mocks.listCredentials).toHaveBeenCalled();
    });

    expect(screen.queryByText('UI Migration Work Items')).not.toBeInTheDocument();
    expect(screen.queryByText('Compliance & Exceptions')).not.toBeInTheDocument();
  });
});
