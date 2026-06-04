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

// Configure the user's OWN cloud + GitHub creds, with the agent credential
// active or inactive. `hasAgent` requires an active agent credential.
function mockOwnSetup({ agentActive }: { agentActive: boolean }) {
  mocks.listAgentCredentials.mockResolvedValue({ credentials: [{ isActive: agentActive }] });
  mocks.listCredentials.mockResolvedValue([{ provider: 'hetzner' }]);
  mocks.listGitHubInstallations.mockResolvedValue([{ id: 'inst-1' }]);
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
    mockOwnSetup({ agentActive: true });
    renderProvider();
    await waitFor(() => expect(screen.getByTestId('loading')).toHaveTextContent('ready'));
    expect(screen.getByTestId('overlay')).toHaveTextContent('closed');
    expect(localStorage.getItem(STORAGE_KEY)).toBe('true');
  });

  it('keeps the overlay open when the only agent credential is inactive', async () => {
    // An inactive agent credential does NOT count as the user having configured
    // their own agent (hasAgent requires isActive). Cloud + GitHub are present,
    // so this isolates the agent branch: onboarding must still appear.
    mockOwnSetup({ agentActive: false });
    renderProvider();
    await waitFor(() => expect(screen.getByTestId('loading')).toHaveTextContent('ready'));
    expect(screen.getByTestId('overlay')).toHaveTextContent('open');
    // The user never dismissed, so no flag should have been written.
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
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
    // ?onboarding resets in-memory `dismissed` so the overlay re-shows, but it
    // MUST NOT clear the persisted dismissal flag — re-navigating without the
    // param keeps the overlay closed.
    expect(localStorage.getItem(STORAGE_KEY)).toBe('true');
  });

  it('re-opens via ?onboarding even when setup is complete', async () => {
    mockOwnSetup({ agentActive: true });
    setUrl('/?onboarding');
    renderProvider();
    await waitFor(() => expect(screen.getByTestId('loading')).toHaveTextContent('ready'));
    expect(screen.getByTestId('overlay')).toHaveTextContent('open');
  });
});
