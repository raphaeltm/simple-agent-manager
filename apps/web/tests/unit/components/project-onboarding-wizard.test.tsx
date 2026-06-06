import type { AgentInfo, GitHubInstallation, Project } from '@simple-agent-manager/shared';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createProject: vi.fn(),
  listRepositories: vi.fn(),
  listBranches: vi.fn(),
  listAgents: vi.fn(),
  createAgentProfile: vi.fn(),
  createTrigger: vi.fn(),
  submitTask: vi.fn(),
  navigate: vi.fn(),
}));

vi.mock('react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-router')>()),
  useNavigate: () => mocks.navigate,
}));

vi.mock('../../../src/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/lib/api')>()),
  createProject: mocks.createProject,
  listRepositories: mocks.listRepositories,
  listBranches: mocks.listBranches,
  listAgents: mocks.listAgents,
  createAgentProfile: mocks.createAgentProfile,
  createTrigger: mocks.createTrigger,
  submitTask: mocks.submitTask,
}));

import { ProjectOnboardingWizard } from '../../../src/components/project-onboarding/ProjectOnboardingWizard';
import { ApiClientError } from '../../../src/lib/api';

const INSTALLATION: GitHubInstallation = {
  id: 'inst-1',
  userId: 'user-1',
  installationId: '1001',
  accountType: 'organization',
  accountName: 'acme',
  createdAt: '2026-06-06T00:00:00Z',
  updatedAt: '2026-06-06T00:00:00Z',
};

const PROJECT: Project = {
  id: 'proj-1',
  userId: 'user-1',
  name: 'repo-one',
  description: null,
  installationId: 'inst-1',
  repository: 'acme/repo-one',
  defaultBranch: 'main',
  status: 'active',
  activeWorkspaceCount: 0,
  createdAt: '2026-06-06T00:00:00Z',
  updatedAt: '2026-06-06T00:00:00Z',
};

const AGENTS: AgentInfo[] = [
  {
    id: 'codex',
    name: 'Codex',
    description: 'OpenAI Codex',
    supportsAcp: true,
    configured: true,
    credentialHelpUrl: 'https://example.com/codex',
    fallbackCredentialSource: null,
  },
  {
    id: 'claude-code',
    name: 'Claude Code',
    description: 'Anthropic Claude Code',
    supportsAcp: true,
    configured: false,
    credentialHelpUrl: 'https://example.com/claude',
    fallbackCredentialSource: null,
  },
];

function renderWizard() {
  return render(
    <MemoryRouter>
      <ProjectOnboardingWizard installations={[INSTALLATION]} />
    </MemoryRouter>,
  );
}

async function createProjectThroughUi(user: ReturnType<typeof userEvent.setup>) {
  renderWizard();
  await waitFor(() => expect(mocks.listRepositories).toHaveBeenCalledWith('inst-1'));

  await user.click(screen.getByPlaceholderText('https://github.com/user/repo or select from list'));
  await user.click(await screen.findByText('acme/repo-one'));
  await user.click(screen.getByRole('button', { name: 'Create project' }));

  await waitFor(() => expect(mocks.createProject).toHaveBeenCalled());
}

describe('ProjectOnboardingWizard', () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listRepositories.mockResolvedValue({
      repositories: [
        {
          id: 101,
          fullName: 'acme/repo-one',
          name: 'repo-one',
          private: false,
          defaultBranch: 'main',
          installationId: 'inst-1',
        },
      ],
      total: 1,
    });
    mocks.listBranches.mockResolvedValue([{ name: 'main' }, { name: 'release/2026' }]);
    mocks.createProject.mockResolvedValue(PROJECT);
    mocks.listAgents.mockResolvedValue({ agents: AGENTS });
    mocks.createAgentProfile.mockImplementation((_projectId: string, body: { name: string; taskMode?: string }) =>
      Promise.resolve({
        id: `${body.taskMode ?? 'profile'}-profile`,
        projectId: 'proj-1',
        userId: 'user-1',
        name: body.name,
        description: null,
        agentType: 'codex',
        model: null,
        permissionMode: null,
        systemPromptAppend: null,
        maxTurns: null,
        timeoutMinutes: null,
        vmSizeOverride: null,
        provider: null,
        vmLocation: null,
        workspaceProfile: null,
        devcontainerConfigName: null,
        taskMode: body.taskMode ?? null,
        githubCliPolicy: null,
        isBuiltin: false,
        createdAt: '2026-06-06T00:00:00Z',
        updatedAt: '2026-06-06T00:00:00Z',
      }),
    );
    mocks.createTrigger.mockResolvedValue({ id: 'trigger-1' });
    mocks.submitTask.mockResolvedValue({
      taskId: 'task-1',
      sessionId: 'session-1',
      branchName: 'sam/task-1',
      status: 'queued',
    });
  });

  it('creates a GitHub project from selected repo and handles duplicate repository collisions inline', async () => {
    const user = userEvent.setup();
    mocks.createProject.mockRejectedValueOnce(
      new ApiClientError('CONFLICT', 'Project repository is already linked', 409),
    );

    renderWizard();
    await waitFor(() => expect(mocks.listRepositories).toHaveBeenCalledWith('inst-1'));
    await user.click(screen.getByPlaceholderText('https://github.com/user/repo or select from list'));
    await user.click(await screen.findByText('acme/repo-one'));
    await user.click(screen.getByRole('button', { name: 'Create project' }));

    await waitFor(() => {
      expect(mocks.createProject).toHaveBeenCalledWith({
        name: 'repo-one',
        description: undefined,
        repoProvider: 'github',
        installationId: 'inst-1',
        repository: 'acme/repo-one',
        defaultBranch: 'main',
        githubRepoId: 101,
      });
    });
    expect(await screen.findByText('This repository is already linked to another project.')).toBeInTheDocument();
  });

  it('filters setup agents to configured agents and omits inherited githubCliPolicy', async () => {
    const user = userEvent.setup();
    await createProjectThroughUi(user);

    expect(await screen.findByText('Set up repo-one')).toBeInTheDocument();
    const agentSelects = screen.getAllByLabelText('Agent') as HTMLSelectElement[];
    expect(agentSelects).toHaveLength(2);
    expect(within(agentSelects[0]).getByRole('option', { name: 'Codex' })).toBeInTheDocument();
    expect(within(agentSelects[0]).queryByRole('option', { name: 'Claude Code' })).not.toBeInTheDocument();

    await user.click(screen.getAllByRole('button', { name: 'Create profile' })[0]);
    await waitFor(() => {
      expect(mocks.createAgentProfile).toHaveBeenCalledWith(
        'proj-1',
        expect.not.objectContaining({ githubCliPolicy: expect.anything() }),
      );
    });
  });

  it('sends exact custom githubCliPolicy schema and cron-only trigger payload without skills', async () => {
    const user = userEvent.setup();
    await createProjectThroughUi(user);

    await user.click(screen.getAllByLabelText('Use a custom GitHub CLI policy for this project repository.')[0]);
    await user.click(screen.getAllByRole('button', { name: 'Create profile' })[0]);
    await waitFor(() => expect(mocks.createAgentProfile).toHaveBeenCalledTimes(1));
    expect(mocks.createAgentProfile).toHaveBeenLastCalledWith(
      'proj-1',
      expect.objectContaining({
        taskMode: 'conversation',
        githubCliPolicy: {
          mode: 'custom',
          repositoryScope: 'project',
          permissions: {
            contents: 'write',
            pullRequests: 'write',
            issues: 'write',
            actions: 'read',
            packages: 'read',
          },
        },
      }),
    );

    await user.click(screen.getByRole('button', { name: 'Create trigger' }));
    await waitFor(() => expect(mocks.createTrigger).toHaveBeenCalled());
    expect(mocks.createTrigger).toHaveBeenCalledWith(
      'proj-1',
      expect.objectContaining({
        sourceType: 'cron',
        cronExpression: '0 9 * * *',
        taskMode: 'task',
      }),
    );
    expect(mocks.createTrigger.mock.calls[0][1]).not.toHaveProperty('skillId');
  });

  it('starts kickoff through tasks submit and handles missing cloud credentials gracefully', async () => {
    const user = userEvent.setup();
    mocks.submitTask.mockRejectedValueOnce(
      new ApiClientError('FORBIDDEN', 'Cloud credentials are required', 403),
    );
    await createProjectThroughUi(user);

    await user.click(screen.getAllByRole('button', { name: 'Skip profile' })[0]);
    await user.click(screen.getAllByRole('button', { name: 'Skip profile' })[0]);
    await user.click(screen.getByRole('button', { name: 'Skip trigger' }));
    await user.click(screen.getByRole('button', { name: /Continue/ }));
    await user.click(screen.getByRole('button', { name: 'Start task' }));

    await waitFor(() => {
      expect(mocks.submitTask).toHaveBeenCalledWith('proj-1', {
        message: 'Review this repository and suggest the highest-impact next steps.',
        taskMode: 'task',
        agentProfileId: undefined,
      });
    });
    expect(
      await screen.findByText('Cloud credentials are required before SAM can start a task or conversation for this project.'),
    ).toBeInTheDocument();
  });
});
