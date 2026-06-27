import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ProjectOnboardingWizard } from '../../../src/components/project-onboarding';

const mockNavigate = vi.fn();
vi.mock('react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-router')>()),
  useNavigate: () => mockNavigate,
}));

const mockCreateProject = vi.fn();
const mockCreateAgentProfile = vi.fn();
const mockCreateTrigger = vi.fn();
const mockListAgents = vi.fn().mockResolvedValue({ agents: [] });
const mockListBranches = vi.fn().mockResolvedValue([{ name: 'main' }, { name: 'develop' }]);
const mockSubmitTask = vi.fn();

vi.mock('../../../src/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/lib/api')>()),
  createProject: (...args: unknown[]) => mockCreateProject(...args),
  createAgentProfile: (...args: unknown[]) => mockCreateAgentProfile(...args),
  createTrigger: (...args: unknown[]) => mockCreateTrigger(...args),
  listAgents: (...args: unknown[]) => mockListAgents(...args),
  listBranches: (...args: unknown[]) => mockListBranches(...args),
  submitTask: (...args: unknown[]) => mockSubmitTask(...args),
}));

// Mock RepoSelector and BranchSelector as simple inputs so we can set form values
vi.mock('../../../src/components/RepoSelector', () => ({
  RepoSelector: ({ value, onChange, id }: { value: string; onChange: (v: string) => void; id?: string }) => (
    <input
      id={id}
      data-testid="repo-selector"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder="owner/repo"
    />
  ),
}));

vi.mock('../../../src/components/BranchSelector', () => ({
  BranchSelector: ({ value, onChange, id }: { value: string; onChange: (v: string) => void; id?: string }) => (
    <input
      id={id}
      data-testid="branch-selector"
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  ),
}));

const INSTALLATIONS = [
  { id: 'inst-1', accountName: 'test-org', accountType: 'Organization' as const },
];

const MOCK_PROJECT = {
  id: 'proj-1',
  name: 'my-repo',
  description: null,
  repository: 'test-org/my-repo',
  defaultBranch: 'main',
  installationId: 'inst-1',
  status: 'active' as const,
  repoProvider: 'github' as const,
  createdAt: '2026-06-27T00:00:00Z',
  updatedAt: '2026-06-27T00:00:00Z',
  userId: 'user-1',
};

const MOCK_AGENTS = [
  { id: 'claude-code', name: 'Claude Code', configured: true, models: ['claude-sonnet-4-5-20250514'] },
];

function renderWizard(props = {}) {
  return render(
    <MemoryRouter>
      <ProjectOnboardingWizard installations={INSTALLATIONS} {...props} />
    </MemoryRouter>,
  );
}

function fillStep1Form() {
  fireEvent.change(screen.getByPlaceholderText('Project name'), { target: { value: 'my-repo' } });
  fireEvent.change(screen.getByTestId('repo-selector'), { target: { value: 'test-org/my-repo' } });
}

async function submitStep1() {
  const form = screen.getByText('Create project').closest('form')!;
  fireEvent.submit(form);
}

describe('ProjectOnboardingWizard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockNavigate.mockReset();
    mockCreateProject.mockReset();
    mockCreateAgentProfile.mockReset();
    mockCreateTrigger.mockReset();
    mockListAgents.mockReset().mockResolvedValue({ agents: [] });
    mockListBranches.mockReset().mockResolvedValue([{ name: 'main' }, { name: 'develop' }]);
    mockSubmitTask.mockReset();
  });

  /* ─── Step 1: Rendering ─── */

  it('renders step indicator with all three steps', () => {
    renderWizard();
    const steps = screen.getByRole('list', { name: 'Project onboarding steps' });
    expect(steps).toBeInTheDocument();
    expect(steps.querySelectorAll('li')).toHaveLength(3);
  });

  it('renders the connect form with installation picker', () => {
    renderWizard();
    expect(screen.getByRole('heading', { name: 'Connect code' })).toBeInTheDocument();
    expect(screen.getByText('test-org (Organization)')).toBeInTheDocument();
    expect(screen.getByText('Create project')).toBeInTheDocument();
  });

  it('shows loading skeleton when loading is true', () => {
    renderWizard({ loading: true });
    expect(screen.queryByRole('heading', { name: 'Connect code' })).not.toBeInTheDocument();
  });

  it('shows error alert with retry button when loadError is set', () => {
    const onRetry = vi.fn();
    renderWizard({ loadError: 'Network error', onRetryInstallations: onRetry });
    expect(screen.getByText('Network error')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Retry'));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('shows warning when no installations available', () => {
    renderWizard({ installations: [] });
    expect(screen.getByText(/Install the GitHub App/)).toBeInTheDocument();
  });

  it('renders project name and description inputs', () => {
    renderWizard();
    expect(screen.getByPlaceholderText('Project name')).toBeInTheDocument();
    expect(screen.getByText('Description')).toBeInTheDocument();
  });

  it('renders branch selector label', () => {
    renderWizard();
    expect(screen.getByText('Branch')).toBeInTheDocument();
  });

  it('navigates to /projects on cancel', () => {
    renderWizard();
    fireEvent.click(screen.getByText('Cancel'));
    expect(mockNavigate).toHaveBeenCalledWith('/projects');
  });

  /* ─── Step 1: Validation ─── */

  it('validates project name is required', async () => {
    renderWizard();
    fireEvent.change(screen.getByTestId('repo-selector'), { target: { value: 'org/repo' } });
    await submitStep1();
    expect(await screen.findByText('Project name is required.')).toBeInTheDocument();
    expect(mockCreateProject).not.toHaveBeenCalled();
  });

  it('validates repository is required', async () => {
    renderWizard();
    fireEvent.change(screen.getByPlaceholderText('Project name'), { target: { value: 'test' } });
    await submitStep1();
    expect(await screen.findByText('Repository is required.')).toBeInTheDocument();
    expect(mockCreateProject).not.toHaveBeenCalled();
  });

  /* ─── Step progression: connect → setup ─── */

  it('advances to setup step after successful project creation', async () => {
    mockCreateProject.mockResolvedValue(MOCK_PROJECT);
    mockListAgents.mockResolvedValue({ agents: MOCK_AGENTS });
    renderWizard();

    fillStep1Form();
    await submitStep1();

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /Set up/ })).toBeInTheDocument();
    });
    expect(screen.queryByRole('heading', { name: 'Connect code' })).not.toBeInTheDocument();
    expect(mockCreateProject).toHaveBeenCalledTimes(1);
    expect(mockListAgents).toHaveBeenCalledTimes(1);
  });

  /* ─── Step 1: Error paths (409 conflict) ─── */

  it('displays name conflict error from 409 response', async () => {
    const mod = await import('../../../src/lib/api');
    mockCreateProject.mockRejectedValue(new mod.ApiClientError('CONFLICT', 'Project name conflict', 409));
    renderWizard();

    fillStep1Form();
    await submitStep1();

    await waitFor(() => {
      expect(screen.getByText('A project with this name already exists.')).toBeInTheDocument();
    });
    expect(screen.getByRole('heading', { name: 'Connect code' })).toBeInTheDocument();
  });

  it('displays repository conflict error from 409 response', async () => {
    const mod = await import('../../../src/lib/api');
    mockCreateProject.mockRejectedValue(new mod.ApiClientError('CONFLICT', 'repository conflict', 409));
    renderWizard();

    fillStep1Form();
    await submitStep1();

    await waitFor(() => {
      expect(screen.getByText('This repository is already linked to another project.')).toBeInTheDocument();
    });
  });

  it('displays generic error from non-409 rejection', async () => {
    mockCreateProject.mockRejectedValue(new Error('Server error'));
    renderWizard();

    fillStep1Form();
    await submitStep1();

    await waitFor(() => {
      expect(screen.getByText('Server error')).toBeInTheDocument();
    });
  });

  /* ─── Step 2: Setup ─── */

  describe('Step 2: Setup', () => {
    async function advanceToStep2() {
      mockCreateProject.mockResolvedValue(MOCK_PROJECT);
      mockListAgents.mockResolvedValue({ agents: MOCK_AGENTS });
      renderWizard();
      fillStep1Form();
      await submitStep1();
      await waitFor(() => {
        expect(screen.getByRole('heading', { name: /Set up/ })).toBeInTheDocument();
      });
    }

    it('shows profile setup panels and trigger form', async () => {
      await advanceToStep2();
      expect(screen.getByText('Conversation profile')).toBeInTheDocument();
      expect(screen.getByText('Task profile')).toBeInTheDocument();
      expect(screen.getByText('Cron trigger')).toBeInTheDocument();
    });

    it('skip buttons enable Continue', async () => {
      await advanceToStep2();

      const continueBtn = screen.getByText(/Continue/);
      expect(continueBtn).toBeDisabled();

      // Skip all three items
      const skipButtons = screen.getAllByText(/Skip/);
      for (const btn of skipButtons) {
        fireEvent.click(btn);
      }

      await waitFor(() => {
        expect(screen.getByText(/Continue/)).not.toBeDisabled();
      });
    });

    it('creates a profile and calls createAgentProfile', async () => {
      const mockProfile = { id: 'profile-1', name: 'Conversation profile', taskMode: 'conversation' };
      mockCreateAgentProfile.mockResolvedValue(mockProfile);
      await advanceToStep2();

      const createButtons = screen.getAllByText('Create profile');
      fireEvent.click(createButtons[0]);

      await waitFor(() => {
        expect(mockCreateAgentProfile).toHaveBeenCalledTimes(1);
        expect(mockCreateAgentProfile).toHaveBeenCalledWith('proj-1', expect.objectContaining({
          name: 'Conversation profile',
          taskMode: 'conversation',
        }));
      });
    });

    it('shows error when profile creation fails', async () => {
      mockCreateAgentProfile.mockRejectedValue(new Error('Profile creation failed'));
      await advanceToStep2();

      const createButtons = screen.getAllByText('Create profile');
      fireEvent.click(createButtons[0]);

      await waitFor(() => {
        expect(screen.getByText('Profile creation failed')).toBeInTheDocument();
      });
    });

    it('Continue button advances to kickoff step', async () => {
      await advanceToStep2();

      const skipButtons = screen.getAllByText(/Skip/);
      for (const btn of skipButtons) {
        fireEvent.click(btn);
      }

      await waitFor(() => {
        expect(screen.getByText(/Continue/)).not.toBeDisabled();
      });

      fireEvent.click(screen.getByText(/Continue/));

      await waitFor(() => {
        expect(screen.getByRole('heading', { name: 'Kick off' })).toBeInTheDocument();
      });
    });

    it('Open project button navigates to the project page', async () => {
      await advanceToStep2();
      fireEvent.click(screen.getByText('Open project'));
      expect(mockNavigate).toHaveBeenCalledWith('/projects/proj-1');
    });
  });

  /* ─── Step 3: Kickoff ─── */

  describe('Step 3: Kickoff', () => {
    async function advanceToStep3() {
      mockCreateProject.mockResolvedValue(MOCK_PROJECT);
      mockListAgents.mockResolvedValue({ agents: MOCK_AGENTS });
      renderWizard();
      fillStep1Form();
      await submitStep1();
      await waitFor(() => {
        expect(screen.getByRole('heading', { name: /Set up/ })).toBeInTheDocument();
      });

      const skipButtons = screen.getAllByText(/Skip/);
      for (const btn of skipButtons) {
        fireEvent.click(btn);
      }
      await waitFor(() => {
        expect(screen.getByText(/Continue/)).not.toBeDisabled();
      });
      fireEvent.click(screen.getByText(/Continue/));
      await waitFor(() => {
        expect(screen.getByRole('heading', { name: 'Kick off' })).toBeInTheDocument();
      });
    }

    it('renders task and conversation mode buttons', async () => {
      await advanceToStep3();
      expect(screen.getByText('Task')).toBeInTheDocument();
      expect(screen.getByText('Conversation')).toBeInTheDocument();
    });

    it('mode buttons toggle aria-pressed state', async () => {
      await advanceToStep3();
      const taskBtn = screen.getByText('Task').closest('button')!;
      const convBtn = screen.getByText('Conversation').closest('button')!;

      expect(taskBtn).toHaveAttribute('aria-pressed', 'true');
      expect(convBtn).toHaveAttribute('aria-pressed', 'false');

      fireEvent.click(convBtn);

      await waitFor(() => {
        expect(convBtn).toHaveAttribute('aria-pressed', 'true');
        expect(taskBtn).toHaveAttribute('aria-pressed', 'false');
      });
    });

    it('successful task kickoff navigates to task page', async () => {
      mockSubmitTask.mockResolvedValue({ taskId: 'task-1', sessionId: 'sess-1' });
      await advanceToStep3();

      fireEvent.click(screen.getByText('Start'));

      await waitFor(() => {
        expect(mockSubmitTask).toHaveBeenCalledWith('proj-1', expect.objectContaining({
          taskMode: 'task',
        }));
        expect(mockNavigate).toHaveBeenCalledWith('/projects/proj-1/tasks/task-1');
      });
    });

    it('successful conversation kickoff navigates to chat page', async () => {
      mockSubmitTask.mockResolvedValue({ taskId: 'task-2', sessionId: 'sess-2' });
      await advanceToStep3();

      fireEvent.click(screen.getByText('Conversation').closest('button')!);
      fireEvent.click(screen.getByText('Start'));

      await waitFor(() => {
        expect(mockSubmitTask).toHaveBeenCalledWith('proj-1', expect.objectContaining({
          taskMode: 'conversation',
        }));
        expect(mockNavigate).toHaveBeenCalledWith('/projects/proj-1/chat/sess-2');
      });
    });

    it('shows error when kickoff fails with not-approved 403', async () => {
      const mod = await import('../../../src/lib/api');
      mockSubmitTask.mockRejectedValue(new mod.ApiClientError('FORBIDDEN', 'Account not approved', 403));
      await advanceToStep3();

      fireEvent.click(screen.getByText('Start'));

      await waitFor(() => {
        expect(screen.getByText(/pending approval/)).toBeInTheDocument();
      });
    });

    it('shows error when kickoff fails with credential 403', async () => {
      const mod = await import('../../../src/lib/api');
      mockSubmitTask.mockRejectedValue(new mod.ApiClientError('FORBIDDEN', 'Forbidden', 403));
      await advanceToStep3();

      fireEvent.click(screen.getByText('Start'));

      await waitFor(() => {
        expect(screen.getByText(/Cloud credentials are required/)).toBeInTheDocument();
      });
    });

    it('shows generic error when kickoff fails', async () => {
      mockSubmitTask.mockRejectedValue(new Error('Network failure'));
      await advanceToStep3();

      fireEvent.click(screen.getByText('Start'));

      await waitFor(() => {
        expect(screen.getByText('Network failure')).toBeInTheDocument();
      });
    });

    it('skip and open project navigates correctly', async () => {
      await advanceToStep3();
      fireEvent.click(screen.getByText('Skip and open project'));
      expect(mockNavigate).toHaveBeenCalledWith('/projects/proj-1');
    });
  });
});
