import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  listCredentials: vi.fn(),
  listGitHubInstallations: vi.fn(),
  listAgentCredentials: vi.fn(),
}));

vi.mock('../../../src/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/lib/api')>()),
  listCredentials: mocks.listCredentials,
  listGitHubInstallations: mocks.listGitHubInstallations,
  listAgentCredentials: mocks.listAgentCredentials,
}));

vi.mock('../../../src/components/AuthProvider', () => ({
  useAuth: () => ({
    user: { id: 'user_123', email: 'dev@example.com', name: 'Dev User' },
  }),
}));

import {
  OnboardingProvider,
  useOnboarding,
} from '../../../src/components/onboarding/OnboardingContext';

function Probe() {
  const { showOverlay, loading } = useOnboarding();
  return (
    <div>
      <span data-testid="loading">{loading ? 'loading' : 'ready'}</span>
      <span data-testid="overlay">{showOverlay ? 'open' : 'closed'}</span>
    </div>
  );
}

function renderProvider() {
  return render(
    <OnboardingProvider>
      <Probe />
    </OnboardingProvider>
  );
}

const STORAGE_KEY = 'sam-onboarding-wizard-dismissed-user_123';

function setUrl(search: string) {
  window.history.replaceState({}, '', search);
}

describe('OnboardingProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    setUrl('/');
    // Default: user has no credentials of their own.
    mocks.listCredentials.mockResolvedValue([]);
    mocks.listGitHubInstallations.mockResolvedValue([]);
    mocks.listAgentCredentials.mockResolvedValue({ credentials: [] });
  });

  it('auto-opens the overlay on first visit when the user has no setup of their own', async () => {
    renderProvider();
    await waitFor(() => expect(screen.getByTestId('loading')).toHaveTextContent('ready'));
    expect(screen.getByTestId('overlay')).toHaveTextContent('open');
  });

  it('does NOT auto-complete onboarding when the user lacks their own agent/cloud creds', async () => {
    // Only GitHub is connected. Platform availability is irrelevant — no trial
    // status is consulted, so the overlay must still appear.
    mocks.listGitHubInstallations.mockResolvedValue([{ id: 'inst-1' }]);
    renderProvider();
    await waitFor(() => expect(screen.getByTestId('loading')).toHaveTextContent('ready'));
    expect(screen.getByTestId('overlay')).toHaveTextContent('open');
  });

  it('auto-dismisses when the user has their own agent + cloud + GitHub', async () => {
    mocks.listAgentCredentials.mockResolvedValue({ credentials: [{ isActive: true }] });
    mocks.listCredentials.mockResolvedValue([{ provider: 'hetzner' }]);
    mocks.listGitHubInstallations.mockResolvedValue([{ id: 'inst-1' }]);
    renderProvider();
    await waitFor(() => expect(screen.getByTestId('loading')).toHaveTextContent('ready'));
    expect(screen.getByTestId('overlay')).toHaveTextContent('closed');
    expect(localStorage.getItem(STORAGE_KEY)).toBe('true');
  });

  it('does not auto-open when the user previously dismissed', async () => {
    localStorage.setItem(STORAGE_KEY, 'true');
    renderProvider();
    await waitFor(() => expect(screen.getByTestId('loading')).toHaveTextContent('ready'));
    expect(screen.getByTestId('overlay')).toHaveTextContent('closed');
  });

  it('re-opens via ?onboarding even when the user previously dismissed', async () => {
    localStorage.setItem(STORAGE_KEY, 'true');
    setUrl('/?onboarding');
    renderProvider();
    await waitFor(() => expect(screen.getByTestId('loading')).toHaveTextContent('ready'));
    expect(screen.getByTestId('overlay')).toHaveTextContent('open');
  });

  it('re-opens via ?onboarding even when setup is complete', async () => {
    mocks.listAgentCredentials.mockResolvedValue({ credentials: [{ isActive: true }] });
    mocks.listCredentials.mockResolvedValue([{ provider: 'hetzner' }]);
    mocks.listGitHubInstallations.mockResolvedValue([{ id: 'inst-1' }]);
    setUrl('/?onboarding');
    renderProvider();
    await waitFor(() => expect(screen.getByTestId('loading')).toHaveTextContent('ready'));
    expect(screen.getByTestId('overlay')).toHaveTextContent('open');
  });
});
