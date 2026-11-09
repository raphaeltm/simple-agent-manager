import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  dismissOnboarding: vi.fn(),
  useOnboarding: vi.fn(),
  getArtifactsEnabled: vi.fn(),
  getInstantRuntimeEnabled: vi.fn(),
  getTrialStatus: vi.fn(),
  listCredentials: vi.fn(),
  listGitHubInstallations: vi.fn(),
  listAgentCredentials: vi.fn(),
}));

// `useQueryScope()` reads the authenticated identity; the setup reads are keyed by it.
vi.mock('../../../../../src/components/AuthProvider', () => ({
  useAuth: () => ({ user: { id: 'user-1', email: 'user@example.com', name: 'Test User' } }),
}));

vi.mock('../../../../../src/components/onboarding/OnboardingContext', () => ({
  useOnboarding: mocks.useOnboarding,
}));

vi.mock('../../../../../src/lib/api', () => ({
  listAgentCredentials: mocks.listAgentCredentials,
  listAgents: vi.fn(() => Promise.resolve({ agents: [] })),
  listCredentials: mocks.listCredentials,
  listGitHubInstallations: mocks.listGitHubInstallations,
  listProjects: vi.fn(() => Promise.resolve({ projects: [] })),
  getArtifactsEnabled: mocks.getArtifactsEnabled,
  getInstantRuntimeEnabled: mocks.getInstantRuntimeEnabled,
  getTrialStatus: mocks.getTrialStatus,
  getAgentCredentialSetupConfig: vi.fn(() => Promise.resolve({ enabled: false })),
  validateAgentCredential: vi.fn(() => Promise.resolve({ valid: true })),
  saveAgentCredential: vi.fn(() => Promise.resolve({})),
  listRepositories: vi.fn(() => Promise.resolve({ repositories: [] })),
}));

import { ChoosePathWizard } from '../../../../../src/components/onboarding/choose-path/ChoosePathWizard';
import { QueryTestWrapper } from '../../../../test-utils/query-test-utils';

function renderWizard() {
  return render(<ChoosePathWizard />, { wrapper: QueryTestWrapper });
}

async function begin() {
  const start = await screen.findByRole('button', { name: /Let's get you set up/ });
  await waitFor(() => expect(start).toBeEnabled());
  fireEvent.click(start);
}

describe('ChoosePathWizard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.useOnboarding.mockReturnValue({
      showOverlay: true,
      dismissOnboarding: mocks.dismissOnboarding,
    });
    mocks.getArtifactsEnabled.mockResolvedValue(false);
    mocks.getInstantRuntimeEnabled.mockResolvedValue(false);
    mocks.getTrialStatus.mockResolvedValue({
      hasInfraCredential: false,
      hasAgentCredential: false,
    });
    mocks.listCredentials.mockResolvedValue([]);
    mocks.listGitHubInstallations.mockResolvedValue([]);
    mocks.listAgentCredentials.mockResolvedValue({ credentials: [] });
  });

  it('opens with SAM saying hello', () => {
    renderWizard();
    expect(screen.getByRole('dialog', { name: 'Set up SAM' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: "Hi, I'm SAM." })).toBeInTheDocument();
  });

  it('renders nothing when the overlay is closed', () => {
    mocks.useOnboarding.mockReturnValue({ showOverlay: false, dismissOnboarding: vi.fn() });
    renderWizard();
    expect(screen.queryByTestId('onboarding-wizard')).not.toBeInTheDocument();
  });

  it('waits to start until it knows what this installation offers', async () => {
    let resolve!: (enabled: boolean) => void;
    mocks.getInstantRuntimeEnabled.mockReturnValue(new Promise<boolean>((r) => (resolve = r)));
    renderWizard();
    expect(await screen.findByRole('button', { name: /Checking what's here/ })).toBeDisabled();
    resolve(true);
    expect(await screen.findByRole('button', { name: /Let's get you set up/ })).toBeEnabled();
  });

  it('asks where agents work when Instant is available, then where code lives', async () => {
    mocks.getInstantRuntimeEnabled.mockResolvedValue(true);
    mocks.getArtifactsEnabled.mockResolvedValue(true);
    renderWizard();
    await begin();

    expect(
      await screen.findByRole('heading', { name: 'Where should your agents work?' })
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Right here, on Cloudflare/ }));
    expect(
      screen.getByRole('heading', { name: 'Where should your code live?' })
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Let SAM keep it/ }));

    // Instant needs no cloud and a SAM-hosted repository needs no GitHub.
    expect(
      await screen.findByRole('heading', { name: 'Who should do the coding?' })
    ).toBeInTheDocument();
    expect(screen.getByRole('list', { name: 'Step 1 of 2' })).toBeInTheDocument();
  });

  it('skips straight to the steps when there is nothing to choose', async () => {
    renderWizard();
    await begin();
    // Own cloud and GitHub are the only options here, so the first screen is the first step.
    expect(
      await screen.findByRole('heading', { name: 'Who should do the coding?' })
    ).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Where should your agents work?' })).toBeNull();
    expect(screen.getByRole('list', { name: 'Step 1 of 4' })).toBeInTheDocument();
  });

  it('goes back from the second question to the first, and from the first to hello', async () => {
    mocks.getInstantRuntimeEnabled.mockResolvedValue(true);
    mocks.getArtifactsEnabled.mockResolvedValue(true);
    renderWizard();
    await begin();
    fireEvent.click(await screen.findByRole('button', { name: /Right here, on Cloudflare/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(
      screen.getByRole('heading', { name: 'Where should your agents work?' })
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.getByRole('heading', { name: "Hi, I'm SAM." })).toBeInTheDocument();
  });

  it('Back during the steps returns to the previous step, then to the questions', async () => {
    mocks.getInstantRuntimeEnabled.mockResolvedValue(true);
    mocks.listGitHubInstallations.mockResolvedValue([{ id: 'inst-1' }]);
    renderWizard();
    await begin();
    fireEvent.click(await screen.findByRole('button', { name: /Right here, on Cloudflare/ }));

    // Instant on connected GitHub: agent, then project.
    fireEvent.click(await screen.findByRole('button', { name: 'Gemini CLI' }));
    fireEvent.change(screen.getByLabelText('Gemini CLI API key'), { target: { value: 'k' } });
    fireEvent.click(screen.getByRole('button', { name: /Use this agent/ }));
    expect(
      await screen.findByRole('heading', { name: 'What are we building?' })
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.getByRole('heading', { name: 'Who should do the coding?' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(
      screen.getByRole('heading', { name: 'Where should your agents work?' })
    ).toBeInTheDocument();
  });

  it('focuses the heading of each screen', async () => {
    mocks.getInstantRuntimeEnabled.mockResolvedValue(true);
    renderWizard();
    expect(screen.getByRole('heading', { name: "Hi, I'm SAM." })).toHaveFocus();
    await begin();
    expect(
      await screen.findByRole('heading', { name: 'Where should your agents work?' })
    ).toHaveFocus();
  });

  it('calls dismissOnboarding when Escape is pressed anywhere in the document', () => {
    renderWizard();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(mocks.dismissOnboarding).toHaveBeenCalledTimes(1);
  });

  // The guided agent sign-in opens its own modal from inside the wizard. Escape there must
  // close only that modal, not throw away the whole setup.
  it('leaves Escape to a dialog opened from inside the wizard', () => {
    renderWizard();
    const nested = document.createElement('div');
    nested.setAttribute('role', 'dialog');
    nested.setAttribute('aria-modal', 'true');
    document.body.appendChild(nested);
    try {
      fireEvent.keyDown(nested, { key: 'Escape' });
      expect(mocks.dismissOnboarding).not.toHaveBeenCalled();
    } finally {
      nested.remove();
    }
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(mocks.dismissOnboarding).toHaveBeenCalledTimes(1);
  });

  it('ignores other keys and stops listening once unmounted', () => {
    const { unmount } = renderWizard();
    fireEvent.keyDown(document, { key: 'a' });
    expect(mocks.dismissOnboarding).not.toHaveBeenCalled();
    unmount();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(mocks.dismissOnboarding).not.toHaveBeenCalled();
  });
});
