import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const mocks = vi.hoisted(() => ({
  listCredentials: vi.fn(),
  listGitHubInstallations: vi.fn(),
  listWorkspaces: vi.fn(),
}));

vi.mock('../../src/lib/api', () => ({
  listCredentials: mocks.listCredentials,
  listGitHubInstallations: mocks.listGitHubInstallations,
  listWorkspaces: mocks.listWorkspaces,
}));

vi.mock('../../src/components/AuthProvider', () => ({
  useAuth: () => ({
    user: { id: 'user_123', email: 'dev@example.com', name: 'Dev User' },
  }),
}));

import { OnboardingChecklist } from '../../src/components/OnboardingChecklist';

function renderChecklist() {
  return render(
    <MemoryRouter>
      <OnboardingChecklist />
    </MemoryRouter>
  );
}

describe('OnboardingChecklist', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    mocks.listCredentials.mockResolvedValue([]);
    mocks.listGitHubInstallations.mockResolvedValue([]);
    mocks.listWorkspaces.mockResolvedValue([]);
  });

  it('shows checklist when setup is incomplete', async () => {
    renderChecklist();

    await waitFor(() => {
      expect(screen.getByText('Get Started')).toBeInTheDocument();
    });

    expect(screen.getByText('Add your Hetzner Cloud API token')).toBeInTheDocument();
    expect(screen.getByText('Install the GitHub App')).toBeInTheDocument();
    expect(screen.getByText('Create your first workspace')).toBeInTheDocument();
    expect(screen.getByText('0 of 3 steps completed')).toBeInTheDocument();
  });

  it('shows completed steps with strikethrough', async () => {
    mocks.listCredentials.mockResolvedValue([{ provider: 'hetzner' }]);
    mocks.listGitHubInstallations.mockResolvedValue([{ id: 'inst-1' }]);

    renderChecklist();

    await waitFor(() => {
      expect(screen.getByText('2 of 3 steps completed')).toBeInTheDocument();
    });
  });

  it('hides checklist when all steps are complete', async () => {
    mocks.listCredentials.mockResolvedValue([{ provider: 'hetzner' }]);
    mocks.listGitHubInstallations.mockResolvedValue([{ id: 'inst-1' }]);
    mocks.listWorkspaces.mockResolvedValue([{ id: 'ws-1' }]);

    const { container } = renderChecklist();

    // Wait for data to load, then confirm nothing is rendered
    await waitFor(() => {
      expect(mocks.listCredentials).toHaveBeenCalled();
    });

    // Give time for state updates
    await new Promise((r) => setTimeout(r, 50));

    expect(container.textContent).toBe('');
  });

  it('dismisses checklist and persists to localStorage', async () => {
    renderChecklist();

    await waitFor(() => {
      expect(screen.getByText('Get Started')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));

    expect(screen.queryByText('Get Started')).not.toBeInTheDocument();
    expect(localStorage.getItem('sam-onboarding-dismissed-user_123')).toBe('true');
  });

  it('stays hidden when previously dismissed', async () => {
    localStorage.setItem('sam-onboarding-dismissed-user_123', 'true');

    const { container } = renderChecklist();

    // Wait for API calls to settle
    await new Promise((r) => setTimeout(r, 50));

    expect(container.textContent).toBe('');
  });
});
