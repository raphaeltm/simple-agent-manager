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

vi.mock('../../../src/components/RepoSelector', () => ({
  RepoSelector: ({ value, onChange, id }: { value: string; onChange: (v: string) => void; id?: string }) => (
    <input id={id} data-testid="repo-selector" value={value} onChange={(e) => onChange(e.target.value)} />
  ),
}));

vi.mock('../../../src/components/BranchSelector', () => ({
  BranchSelector: ({ value, onChange, id }: { value: string; onChange: (v: string) => void; id?: string }) => (
    <input id={id} data-testid="branch-selector" value={value} onChange={(e) => onChange(e.target.value)} />
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
      <ProjectOnboardingWizard installations={INSTALLATIONS} artifactsEnabled {...props} />
    </MemoryRouter>,
  );
}

/** Walk the intro steps (welcome → how-sam-works → provider) to the connect step. */
async function advanceToConnect(provider: 'github' | 'artifacts' = 'github') {
  fireEvent.click(screen.getByRole('button', { name: /Get started/ }));
  await screen.findByRole('heading', { name: 'How SAM works' });
  fireEvent.click(screen.getByRole('button', { name: /Continue/ }));
  await screen.findByRole('heading', { name: /Where should your code live/ });
  if (provider === 'artifacts') {
    fireEvent.click(screen.getByText('Let SAM host the repository'));
  }
  fireEvent.click(screen.getByRole('button', { name: /Continue/ }));
  await screen.findByRole('heading', {
    name: provider === 'artifacts' ? 'Name your project' : 'Connect your code',
  });
}

describe('ProjectOnboardingWizard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockNavigate.mockReset();
    mockCreateProject.mockReset();
    mockCreateAgentProfile.mockReset();
    mockCreateTrigger.mockReset();
    mockListAgents.mockReset().mockResolvedValue({ agents: MOCK_AGENTS });
    mockListBranches.mockReset().mockResolvedValue([{ name: 'main' }, { name: 'develop' }]);
    mockSubmitTask.mockReset();
  });

  /* ─── Intro + progress ─── */

  it('starts on the welcome step with the full 8-step progress rail', () => {
    renderWizard();
    const steps = screen.getByRole('list', { name: 'Onboarding steps' });
    expect(steps.querySelectorAll('li')).toHaveLength(8);
    expect(screen.getByRole('heading', { name: "Let's create your project" })).toBeInTheDocument();
  });

  it('cancel on the welcome step navigates to /projects', () => {
    renderWizard();
    fireEvent.click(screen.getByRole('button', { name: /Cancel/ }));
    expect(mockNavigate).toHaveBeenCalledWith('/projects');
  });

  /* ─── Provider selection ─── */

  it('provider step offers both GitHub and SAM-hosted options, GitHub selected by default', async () => {
    renderWizard();
    fireEvent.click(screen.getByRole('button', { name: /Get started/ }));
    await screen.findByRole('heading', { name: 'How SAM works' });
    fireEvent.click(screen.getByRole('button', { name: /Continue/ }));
    await screen.findByRole('heading', { name: /Where should your code live/ });

    const githubCard = screen.getByText('Connect a GitHub repository').closest('button')!;
    const samCard = screen.getByText('Let SAM host the repository').closest('button')!;
    expect(githubCard).toHaveAttribute('aria-pressed', 'true');
    expect(samCard).toHaveAttribute('aria-pressed', 'false');
  });

  it('hides the SAM option when Artifacts is disabled on the deployment', async () => {
    renderWizard({ artifactsEnabled: false });
    fireEvent.click(screen.getByRole('button', { name: /Get started/ }));
    await screen.findByRole('heading', { name: 'How SAM works' });
    fireEvent.click(screen.getByRole('button', { name: /Continue/ }));
    await screen.findByRole('heading', { name: /Where should your code live/ });

    expect(screen.getByText('Connect a GitHub repository')).toBeInTheDocument();
    expect(screen.queryByText('Let SAM host the repository')).not.toBeInTheDocument();
  });

  /* ─── SAM (Artifacts) connect path ─── */

  it('creates an Artifacts project with no GitHub fields and advances to setup', async () => {
    mockCreateProject.mockResolvedValue({ ...MOCK_PROJECT, repoProvider: 'artifacts' });
    renderWizard();
    await advanceToConnect('artifacts');

    // No GitHub installation picker on the SAM path.
    expect(screen.queryByText('test-org (Organization)')).not.toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText('Project name'), { target: { value: 'greenfield thing' } });
    fireEvent.click(screen.getByRole('button', { name: /Create project/ }));

    await waitFor(() => {
      expect(mockCreateProject).toHaveBeenCalledWith(
        expect.objectContaining({ repoProvider: 'artifacts', name: 'greenfield thing' }),
      );
    });
    const payload = mockCreateProject.mock.calls[0]![0] as Record<string, unknown>;
    expect(payload.installationId).toBeUndefined();
    expect(payload.repository).toBeUndefined();

    await screen.findByRole('heading', { name: 'Set up a conversation agent' });
  });

  it('validates project name is required on the SAM path', async () => {
    renderWizard();
    await advanceToConnect('artifacts');
    fireEvent.click(screen.getByRole('button', { name: /Create project/ }));
    expect(await screen.findByText('Project name is required.')).toBeInTheDocument();
    expect(mockCreateProject).not.toHaveBeenCalled();
  });

  /* ─── GitHub connect path ─── */

  it('creates a GitHub project with installation + repository', async () => {
    mockCreateProject.mockResolvedValue(MOCK_PROJECT);
    renderWizard();
    await advanceToConnect('github');

    expect(screen.getByText('test-org (Organization)')).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText('Project name'), { target: { value: 'my-repo' } });
    fireEvent.change(screen.getByTestId('repo-selector'), { target: { value: 'test-org/my-repo' } });
    fireEvent.click(screen.getByRole('button', { name: /Create project/ }));

    await waitFor(() => {
      expect(mockCreateProject).toHaveBeenCalledWith(
        expect.objectContaining({
          repoProvider: 'github',
          installationId: 'inst-1',
          repository: 'test-org/my-repo',
        }),
      );
    });
    await screen.findByRole('heading', { name: 'Set up a conversation agent' });
  });

  it('shows the GitHub App install warning when no installations exist', async () => {
    renderWizard({ installations: [] });
    await advanceToConnect('github');
    expect(screen.getByText(/Install the GitHub App/)).toBeInTheDocument();
  });

  it('displays name-conflict error from a 409 response', async () => {
    const mod = await import('../../../src/lib/api');
    mockCreateProject.mockRejectedValue(new mod.ApiClientError('CONFLICT', 'Project name conflict', 409));
    renderWizard();
    await advanceToConnect('artifacts');
    fireEvent.change(screen.getByPlaceholderText('Project name'), { target: { value: 'dupe' } });
    fireEvent.click(screen.getByRole('button', { name: /Create project/ }));

    expect(await screen.findByText('A project with this name already exists.')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Name your project' })).toBeInTheDocument();
  });

  /* ─── Setup steps ─── */

  async function advanceToSetup(provider: 'github' | 'artifacts' = 'artifacts') {
    mockCreateProject.mockResolvedValue({ ...MOCK_PROJECT, repoProvider: provider });
    renderWizard();
    await advanceToConnect(provider);
    fireEvent.change(screen.getByPlaceholderText('Project name'), { target: { value: 'my-repo' } });
    if (provider === 'github') {
      fireEvent.change(screen.getByTestId('repo-selector'), { target: { value: 'test-org/my-repo' } });
    }
    fireEvent.click(screen.getByRole('button', { name: /Create project/ }));
    await screen.findByRole('heading', { name: 'Set up a conversation agent' });
  }

  it('creates a conversation profile', async () => {
    const mockProfile = { id: 'profile-1', name: 'Conversation profile', taskMode: 'conversation' };
    mockCreateAgentProfile.mockResolvedValue(mockProfile);
    await advanceToSetup();

    fireEvent.click(screen.getByText('Create profile'));
    await waitFor(() => {
      expect(mockCreateAgentProfile).toHaveBeenCalledWith(
        'proj-1',
        expect.objectContaining({ taskMode: 'conversation' }),
      );
    });
  });

  it('walks conversation → task → automation → kickoff via Continue', async () => {
    await advanceToSetup();
    fireEvent.click(screen.getByRole('button', { name: /Continue/ }));
    await screen.findByRole('heading', { name: 'Set up a task agent' });
    fireEvent.click(screen.getByRole('button', { name: /Continue/ }));
    await screen.findByRole('heading', { name: /Schedule automation/ });
    fireEvent.click(screen.getByRole('button', { name: /Continue/ }));
    await screen.findByRole('heading', { name: 'Kick off your first work' });
  });

  /* ─── Kickoff ─── */

  async function advanceToKickoff() {
    await advanceToSetup();
    fireEvent.click(screen.getByRole('button', { name: /Continue/ }));
    await screen.findByRole('heading', { name: 'Set up a task agent' });
    fireEvent.click(screen.getByRole('button', { name: /Continue/ }));
    await screen.findByRole('heading', { name: /Schedule automation/ });
    fireEvent.click(screen.getByRole('button', { name: /Continue/ }));
    await screen.findByRole('heading', { name: 'Kick off your first work' });
  }

  it('task kickoff submits and navigates to the task page', async () => {
    mockSubmitTask.mockResolvedValue({ taskId: 'task-1', sessionId: 'sess-1' });
    await advanceToKickoff();

    fireEvent.click(screen.getByRole('button', { name: /Start task/ }));
    await waitFor(() => {
      expect(mockSubmitTask).toHaveBeenCalledWith('proj-1', expect.objectContaining({ taskMode: 'task' }));
      expect(mockNavigate).toHaveBeenCalledWith('/projects/proj-1/tasks/task-1');
    });
  });

  it('conversation kickoff submits and navigates to the chat page', async () => {
    mockSubmitTask.mockResolvedValue({ taskId: 'task-2', sessionId: 'sess-2' });
    await advanceToKickoff();

    fireEvent.click(screen.getByText('Conversation').closest('button')!);
    fireEvent.click(screen.getByRole('button', { name: /Start conversation/ }));
    await waitFor(() => {
      expect(mockSubmitTask).toHaveBeenCalledWith('proj-1', expect.objectContaining({ taskMode: 'conversation' }));
      expect(mockNavigate).toHaveBeenCalledWith('/projects/proj-1/chat/sess-2');
    });
  });

  it('skip and open project navigates to the project page', async () => {
    await advanceToKickoff();
    fireEvent.click(screen.getByRole('button', { name: /Skip and open project/ }));
    expect(mockNavigate).toHaveBeenCalledWith('/projects/proj-1');
  });
});
