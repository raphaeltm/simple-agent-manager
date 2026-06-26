import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createProject: vi.fn(),
  listGitHubInstallations: vi.fn(),
  listRepositories: vi.fn(),
}));

vi.mock('../../../src/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/lib/api')>()),
  listGitHubInstallations: mocks.listGitHubInstallations,
  listRepositories: mocks.listRepositories,
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
  });

  it('renders all six catalog agents and reveals the API key input after selecting one', async () => {
    render(
      <MemoryRouter>
        <StepExecution steps={[aiSetupStep]} onComplete={vi.fn()} />
      </MemoryRouter>
    );

    for (const name of ['Claude Code', 'OpenAI Codex', 'Gemini CLI', 'Mistral Vibe', 'OpenCode', 'Amp']) {
      expect(screen.getByRole('button', { name: new RegExp(name) })).toBeInTheDocument();
    }

    // No credential input until an agent is chosen.
    expect(document.querySelector('#onboarding-api-key')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /Claude Code/ }));

    await waitFor(() => {
      expect(document.querySelector('#onboarding-api-key')).not.toBeNull();
    });
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
