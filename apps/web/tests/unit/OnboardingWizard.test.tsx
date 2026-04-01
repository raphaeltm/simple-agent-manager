import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  listCredentials: vi.fn(),
  listGitHubInstallations: vi.fn(),
  listAgentCredentials: vi.fn(),
  saveAgentCredential: vi.fn(),
  createCredential: vi.fn(),
  getGitHubInstallUrl: vi.fn(),
}));

vi.mock('../../src/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/api')>()),
  listCredentials: mocks.listCredentials,
  listGitHubInstallations: mocks.listGitHubInstallations,
  listAgentCredentials: mocks.listAgentCredentials,
  saveAgentCredential: mocks.saveAgentCredential,
  createCredential: mocks.createCredential,
  getGitHubInstallUrl: mocks.getGitHubInstallUrl,
}));

vi.mock('../../src/components/AuthProvider', () => ({
  useAuth: () => ({
    user: { id: 'user_123', email: 'dev@example.com', name: 'Dev User' },
  }),
}));

import { OnboardingWizard } from '../../src/components/onboarding/OnboardingWizard';

function renderWizard() {
  return render(
    <MemoryRouter>
      <OnboardingWizard />
    </MemoryRouter>
  );
}

describe('OnboardingWizard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    mocks.listCredentials.mockResolvedValue([]);
    mocks.listGitHubInstallations.mockResolvedValue([]);
    mocks.listAgentCredentials.mockResolvedValue({ credentials: [] });
  });

  it('shows wizard when setup is incomplete', async () => {
    renderWizard();

    await waitFor(() => {
      expect(screen.getByTestId('onboarding-wizard')).toBeInTheDocument();
    });

    // Should show agent step first
    expect(screen.getByText('Connect your AI agent')).toBeInTheDocument();
  });

  it('shows step indicators for all 4 steps', async () => {
    renderWizard();

    await waitFor(() => {
      expect(screen.getByText('AI Agent')).toBeInTheDocument();
    });

    expect(screen.getByText('Cloud')).toBeInTheDocument();
    expect(screen.getByText('GitHub')).toBeInTheDocument();
    expect(screen.getByText('How it works')).toBeInTheDocument();
  });

  it('hides wizard when all credentials are configured', async () => {
    mocks.listCredentials.mockResolvedValue([{ provider: 'hetzner' }]);
    mocks.listGitHubInstallations.mockResolvedValue([{ id: 'inst-1' }]);
    mocks.listAgentCredentials.mockResolvedValue({
      credentials: [{ agentType: 'claude-code', isActive: true }],
    });

    const { container } = renderWizard();

    await waitFor(() => {
      expect(mocks.listCredentials).toHaveBeenCalled();
    });
    // Give time for state updates
    await new Promise((r) => setTimeout(r, 50));

    expect(container.querySelector('[data-testid="onboarding-wizard"]')).not.toBeInTheDocument();
  });

  it('dismisses wizard and persists to localStorage', async () => {
    renderWizard();

    await waitFor(() => {
      expect(screen.getByText('Don\'t show again')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Don\'t show again'));

    await waitFor(() => {
      expect(screen.queryByTestId('onboarding-wizard')).not.toBeInTheDocument();
    });

    expect(localStorage.getItem('sam-onboarding-wizard-dismissed-user_123')).toBe('true');
  });

  it('stays hidden when previously dismissed', async () => {
    localStorage.setItem('sam-onboarding-wizard-dismissed-user_123', 'true');

    const { container } = renderWizard();

    await new Promise((r) => setTimeout(r, 50));

    expect(container.querySelector('[data-testid="onboarding-wizard"]')).not.toBeInTheDocument();
  });

  it('starts at first incomplete step (skips completed)', async () => {
    mocks.listAgentCredentials.mockResolvedValue({
      credentials: [{ agentType: 'claude-code', isActive: true }],
    });

    renderWizard();

    await waitFor(() => {
      // Should skip agent step and show cloud step
      expect(screen.getByText('Connect your cloud')).toBeInTheDocument();
    });
  });

  it('shows agent step as complete when agent is configured', async () => {
    mocks.listAgentCredentials.mockResolvedValue({
      credentials: [{ agentType: 'claude-code', isActive: true }],
    });

    renderWizard();

    await waitFor(() => {
      expect(screen.getByTestId('onboarding-wizard')).toBeInTheDocument();
    });

    // Click on agent tab to see the complete state
    fireEvent.click(screen.getByText('AI Agent'));

    await waitFor(() => {
      expect(screen.getByText('AI agent connected')).toBeInTheDocument();
    });
  });

  it('navigates between steps via tab clicks', async () => {
    renderWizard();

    await waitFor(() => {
      expect(screen.getByText('Connect your AI agent')).toBeInTheDocument();
    });

    // Click cloud tab
    fireEvent.click(screen.getByText('Cloud'));
    expect(screen.getByText('Connect your cloud')).toBeInTheDocument();

    // Click GitHub tab
    fireEvent.click(screen.getByText('GitHub'));
    expect(screen.getByText('Connect your code')).toBeInTheDocument();

    // Click How it works tab
    fireEvent.click(screen.getByText('How it works'));
    expect(screen.getByText('How SAM works')).toBeInTheDocument();
  });
});

describe('StepAgentKey', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    mocks.listCredentials.mockResolvedValue([]);
    mocks.listGitHubInstallations.mockResolvedValue([]);
    mocks.listAgentCredentials.mockResolvedValue({ credentials: [] });
  });

  it('allows selecting an agent and entering an API key', async () => {
    renderWizard();

    await waitFor(() => {
      expect(screen.getByText('Claude Code')).toBeInTheDocument();
    });

    // Select Claude Code
    fireEvent.click(screen.getByText('Claude Code'));

    // API key input should appear
    await waitFor(() => {
      expect(screen.getByText('Claude Code API Key')).toBeInTheDocument();
    });

    expect(screen.getByText('Where do I get this?')).toBeInTheDocument();
  });

  it('saves agent credential and advances to next step', async () => {
    mocks.saveAgentCredential.mockResolvedValue({
      agentType: 'claude-code',
      isActive: true,
    });
    // After save, re-check shows agent configured
    mocks.listAgentCredentials
      .mockResolvedValueOnce({ credentials: [] })
      .mockResolvedValue({ credentials: [{ agentType: 'claude-code', isActive: true }] });

    renderWizard();

    await waitFor(() => {
      expect(screen.getByText('Claude Code')).toBeInTheDocument();
    });

    // Select Claude Code
    fireEvent.click(screen.getByText('Claude Code'));

    // Enter API key
    const input = screen.getByPlaceholderText('Paste your anthropic API key');
    fireEvent.change(input, { target: { value: 'sk-ant-test-key' } });

    // Click Connect
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));

    await waitFor(() => {
      expect(mocks.saveAgentCredential).toHaveBeenCalledWith({
        agentType: 'claude-code',
        credentialKind: 'api-key',
        credential: 'sk-ant-test-key',
      });
    });
  });

  it('skip advances to cloud step', async () => {
    renderWizard();

    await waitFor(() => {
      expect(screen.getByText('Connect your AI agent')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("Skip this step"));

    await waitFor(() => {
      expect(screen.getByText('Connect your cloud')).toBeInTheDocument();
    });
  });
});

describe('StepCloudProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    mocks.listCredentials.mockResolvedValue([]);
    mocks.listGitHubInstallations.mockResolvedValue([]);
    mocks.listAgentCredentials.mockResolvedValue({ credentials: [] });
  });

  it('saves Hetzner credential', async () => {
    mocks.createCredential.mockResolvedValue({ provider: 'hetzner', connected: true });
    mocks.listCredentials
      .mockResolvedValueOnce([])
      .mockResolvedValue([{ provider: 'hetzner' }]);

    renderWizard();

    // Navigate to cloud step
    await waitFor(() => {
      expect(screen.getByText('Cloud')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText('Cloud'));

    await waitFor(() => {
      expect(screen.getByText('Hetzner')).toBeInTheDocument();
    });

    // Select Hetzner
    fireEvent.click(screen.getByText('Hetzner'));

    // Enter token
    const input = screen.getByPlaceholderText('Paste your Hetzner API token');
    fireEvent.change(input, { target: { value: 'hetzner-test-token' } });

    // Click Connect
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));

    await waitFor(() => {
      expect(mocks.createCredential).toHaveBeenCalledWith({
        provider: 'hetzner',
        token: 'hetzner-test-token',
      });
    });
  });
});

describe('StepGitHub', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    mocks.listCredentials.mockResolvedValue([]);
    mocks.listGitHubInstallations.mockResolvedValue([]);
    mocks.listAgentCredentials.mockResolvedValue({ credentials: [] });
    mocks.getGitHubInstallUrl.mockResolvedValue({ url: 'https://github.com/apps/sam/installations/new' });
  });

  it('shows GitHub install information', async () => {
    renderWizard();

    await waitFor(() => {
      expect(screen.getByText('GitHub')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText('GitHub'));

    await waitFor(() => {
      expect(screen.getByText('Connect your code')).toBeInTheDocument();
    });

    expect(screen.getByText('Lets SAM clone your repos into cloud workspaces')).toBeInTheDocument();
    expect(screen.getByText('You choose which repos to grant access to')).toBeInTheDocument();
  });
});

describe('StepHowItWorks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    mocks.listCredentials.mockResolvedValue([]);
    mocks.listGitHubInstallations.mockResolvedValue([]);
    mocks.listAgentCredentials.mockResolvedValue({ credentials: [] });
  });

  it('shows workflow explanation and two modes', async () => {
    renderWizard();

    await waitFor(() => {
      expect(screen.getByText('How it works')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText('How it works'));

    await waitFor(() => {
      expect(screen.getByText('How SAM works')).toBeInTheDocument();
    });

    expect(screen.getByText('You send a message')).toBeInTheDocument();
    expect(screen.getByText('SAM provisions a workspace')).toBeInTheDocument();
    expect(screen.getByText('Your agent codes')).toBeInTheDocument();
    expect(screen.getByText('You review the results')).toBeInTheDocument();

    // Two modes
    expect(screen.getByText('Task mode')).toBeInTheDocument();
    expect(screen.getByText('Conversation mode')).toBeInTheDocument();
  });

  it('completes wizard when clicking finish button', async () => {
    renderWizard();

    await waitFor(() => {
      expect(screen.getByText('How it works')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText('How it works'));

    await waitFor(() => {
      expect(screen.getByText("Got it, let's go!")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("Got it, let's go!"));

    await waitFor(() => {
      expect(screen.queryByTestId('onboarding-wizard')).not.toBeInTheDocument();
    });

    expect(localStorage.getItem('sam-onboarding-wizard-dismissed-user_123')).toBe('true');
  });
});
