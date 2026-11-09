import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createProject: vi.fn(),
  getAgentCredentialSetupConfig: vi.fn(),
  listGitHubInstallations: vi.fn(),
  listRepositories: vi.fn(),
}));

vi.mock('../../../src/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/lib/api')>()),
  listGitHubInstallations: mocks.listGitHubInstallations,
  listRepositories: mocks.listRepositories,
  getAgentCredentialSetupConfig: mocks.getAgentCredentialSetupConfig,
}));

vi.mock('../../../src/lib/api/projects', () => ({
  createProject: mocks.createProject,
}));

import type { GeneratedStep } from '../../../src/components/onboarding/choose-path/path-generator';
import { StepExecution } from '../../../src/components/onboarding/choose-path/StepExecution';

const projectStep: GeneratedStep = {
  id: 'project',
  title: 'Create your first project',
  description: 'Select one of your GitHub repos to create your first SAM project.',
  actionLabel: 'Choose Repository',
  timeEstimate: '30 seconds',
  details: ['Pick a repo from your connected GitHub account'],
  isOptional: false,
};

const aiSetupStep: GeneratedStep = {
  id: 'ai-setup',
  title: 'Set up your coding agent',
  description: 'Pick an agent and connect it.',
  actionLabel: 'Save agent',
  timeEstimate: '1 minute',
  details: ['Choose from the supported agents'],
  isOptional: false,
};

const cloudByocStep: GeneratedStep = {
  id: 'cloud-byoc',
  title: 'Connect your cloud',
  description: 'Add your Hetzner or Scaleway credentials.',
  actionLabel: 'Save credentials',
  timeEstimate: '1 minute',
  details: ['Bring your own cloud'],
  isOptional: false,
};

const installation = {
  id: 'inst-1',
  userId: 'user-1',
  installationId: '100',
  accountType: 'organization',
  accountName: 'serverspresentation2025',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

const repo = {
  id: 123,
  fullName: 'serverspresentation2025/VoyajApp',
  name: 'VoyajApp',
  private: true,
  defaultBranch: 'main',
  installationId: 'inst-1',
};

function renderProjectStep() {
  const onComplete = vi.fn();

  render(
    <MemoryRouter>
      <StepExecution steps={[projectStep]} onComplete={onComplete} />
    </MemoryRouter>
  );

  return { onComplete };
}

describe('StepExecution project creation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listGitHubInstallations.mockResolvedValue([installation]);
    mocks.listRepositories.mockResolvedValue({ repositories: [repo] });
    mocks.createProject.mockResolvedValue({ id: 'project-1' });
  });

  it('sends the selected repository full name to project creation', async () => {
    const { onComplete } = renderProjectStep();

    await waitFor(() => {
      expect(mocks.listRepositories).toHaveBeenCalledWith('inst-1');
    });

    const select = await screen.findByLabelText('Repository');
    fireEvent.change(select, { target: { value: repo.fullName } });
    fireEvent.click(screen.getByRole('button', { name: /create project/i }));

    await waitFor(() => {
      expect(mocks.createProject).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'VoyajApp',
          repository: 'serverspresentation2025/VoyajApp',
          installationId: 'inst-1',
          githubRepoId: 123,
          defaultBranch: 'main',
        })
      );
    });
    await waitFor(() => expect(onComplete).toHaveBeenCalled());
  });
});

describe('StepExecution ai-setup step', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getAgentCredentialSetupConfig.mockResolvedValue({
      enabled: true,
      agentTypes: ['openai-codex', 'claude-code'],
    });
  });

  function renderAiSetup() {
    render(
      <MemoryRouter>
        <StepExecution steps={[aiSetupStep]} onComplete={vi.fn()} />
      </MemoryRouter>
    );
  }

  it('renders all six catalog agents and reveals the API key input for an API-key-only agent', async () => {
    renderAiSetup();

    for (const name of [
      'Claude Code',
      'OpenAI Codex',
      'Gemini CLI',
      'Mistral Vibe',
      'OpenCode',
      'Amp',
    ]) {
      expect(screen.getByRole('button', { name: new RegExp(name) })).toBeInTheDocument();
    }

    // No credential input until an agent is chosen.
    expect(document.querySelector('#onboarding-api-key')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /Gemini CLI/ }));

    await waitFor(() => {
      expect(document.querySelector('#onboarding-api-key')).not.toBeNull();
    });
  });

  it.each([
    ['Claude Code', 'Connect with Claude Code'],
    ['OpenAI Codex', 'Connect with Codex'],
  ])('offers the guided %s sign-in first, with paste as the fallback', async (agent, button) => {
    renderAiSetup();
    fireEvent.click(screen.getByRole('button', { name: new RegExp(agent) }));

    expect(await screen.findByRole('button', { name: button })).toBeInTheDocument();
    expect(await screen.findByLabelText(/^Or paste/)).toBeInTheDocument();
    expect(document.querySelector('#onboarding-api-key')).toBeNull();
  });

  it('falls back to pasting the subscription token where guided sign-in is unavailable', async () => {
    mocks.getAgentCredentialSetupConfig.mockResolvedValue({ enabled: false });
    renderAiSetup();
    fireEvent.click(screen.getByRole('button', { name: /Claude Code/ }));

    expect(await screen.findByLabelText('OAuth token')).toBeInTheDocument();
    await waitFor(() => expect(mocks.getAgentCredentialSetupConfig).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: 'Connect with Claude Code' })).toBeNull();
  });
});

describe('StepExecution SAM-hosted project step', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createProject.mockResolvedValue({ id: 'project-1' });
  });

  it('creates an Artifacts-backed project from just a name, without touching GitHub', async () => {
    const onComplete = vi.fn();
    render(
      <MemoryRouter>
        <StepExecution
          steps={[{ ...projectStep, actionLabel: 'Create Project', hostedRepo: true }]}
          onComplete={onComplete}
        />
      </MemoryRouter>
    );

    fireEvent.change(screen.getByLabelText('Project name'), { target: { value: 'my-app' } });
    fireEvent.click(screen.getByRole('button', { name: /create project/i }));

    await waitFor(() => {
      expect(mocks.createProject).toHaveBeenCalledWith({
        name: 'my-app',
        repoProvider: 'artifacts',
        defaultBranch: 'main',
      });
    });
    await waitFor(() => expect(onComplete).toHaveBeenCalled());
    expect(mocks.listGitHubInstallations).not.toHaveBeenCalled();
  });
});

describe('StepExecution cloud-byoc step', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('defaults to the Hetzner token input and offers a Scaleway toggle', async () => {
    render(
      <MemoryRouter>
        <StepExecution steps={[cloudByocStep]} onComplete={vi.fn()} />
      </MemoryRouter>
    );

    expect(document.querySelector('#onboarding-hetzner-token')).not.toBeNull();
    expect(screen.getByRole('button', { name: /scaleway/i })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /scaleway/i }));

    await waitFor(() => {
      expect(document.querySelector('#onboarding-scaleway-secret')).not.toBeNull();
    });
    expect(document.querySelector('#onboarding-scaleway-project')).not.toBeNull();
  });
});
