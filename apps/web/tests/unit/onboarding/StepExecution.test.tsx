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
