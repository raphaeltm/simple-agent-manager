import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const mocks = vi.hoisted(() => ({
  listRepositories: vi.fn(),
  listBranches: vi.fn(),
}));

vi.mock('../../../../src/lib/api', () => ({
  listRepositories: mocks.listRepositories,
  listBranches: mocks.listBranches,
}));

import { ProjectForm } from '../../../../src/components/project/ProjectForm';
import type { GitHubInstallation } from '@simple-agent-manager/shared';

const personalInstall: GitHubInstallation = {
  id: 'inst-personal',
  userId: 'user-1',
  installationId: '100',
  accountType: 'personal',
  accountName: 'myuser',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

const orgInstall: GitHubInstallation = {
  id: 'inst-org',
  userId: 'user-1',
  installationId: '200',
  accountType: 'organization',
  accountName: 'my-org',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

const personalRepos = {
  repositories: [
    {
      id: 1,
      fullName: 'myuser/personal-repo',
      name: 'personal-repo',
      private: false,
      defaultBranch: 'main',
      installationId: 'inst-personal',
    },
  ],
};

const orgRepos = {
  repositories: [
    {
      id: 10,
      fullName: 'my-org/org-project',
      name: 'org-project',
      private: false,
      defaultBranch: 'develop',
      installationId: 'inst-org',
    },
  ],
};

describe('ProjectForm installation switching', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: personal installation selected → personal repos
    mocks.listRepositories.mockImplementation((installationId?: string) => {
      if (installationId === 'inst-org') return Promise.resolve(orgRepos);
      return Promise.resolve(personalRepos);
    });
    mocks.listBranches.mockResolvedValue([{ name: 'main' }, { name: 'develop' }]);
  });

  it('passes the selected installationId to RepoSelector', async () => {
    render(
      <ProjectForm
        mode="create"
        installations={[personalInstall, orgInstall]}
        onSubmit={() => {}}
      />
    );

    // Wait for initial repo fetch with first (personal) installation
    await waitFor(() => {
      expect(mocks.listRepositories).toHaveBeenCalledWith('inst-personal');
    });

    // Personal repo should be visible
    fireEvent.focus(screen.getByLabelText('Repository'));
    expect(await screen.findByText('myuser/personal-repo')).toBeInTheDocument();
  });

  it('re-fetches repos when installation changes to org', async () => {
    render(
      <ProjectForm
        mode="create"
        installations={[personalInstall, orgInstall]}
        onSubmit={() => {}}
      />
    );

    // Wait for initial load
    await waitFor(() => {
      expect(mocks.listRepositories).toHaveBeenCalledWith('inst-personal');
    });

    // Switch to org installation
    const installSelect = screen.getByLabelText('Installation');
    fireEvent.change(installSelect, { target: { value: 'inst-org' } });

    // Should re-fetch repos for the org installation
    await waitFor(() => {
      expect(mocks.listRepositories).toHaveBeenCalledWith('inst-org');
    });

    // Org repos should now be visible in dropdown
    fireEvent.focus(screen.getByLabelText('Repository'));
    expect(await screen.findByText('my-org/org-project')).toBeInTheDocument();
    // Personal repos should no longer appear
    expect(screen.queryByText('myuser/personal-repo')).not.toBeInTheDocument();
  });

  it('clears repo and branch when installation changes', async () => {
    render(
      <ProjectForm
        mode="create"
        installations={[personalInstall, orgInstall]}
        onSubmit={() => {}}
      />
    );

    await waitFor(() => {
      expect(mocks.listRepositories).toHaveBeenCalled();
    });

    // Select a repo first
    fireEvent.focus(screen.getByLabelText('Repository'));
    const repoOption = await screen.findByText('myuser/personal-repo');
    fireEvent.click(repoOption);

    // Verify repo is set
    const repoInput = screen.getByLabelText('Repository') as HTMLInputElement;
    expect(repoInput.value).toBe('https://github.com/myuser/personal-repo');

    // Switch installation
    const installSelect = screen.getByLabelText('Installation');
    fireEvent.change(installSelect, { target: { value: 'inst-org' } });

    // Repo should be cleared
    await waitFor(() => {
      const updatedRepoInput = screen.getByLabelText('Repository') as HTMLInputElement;
      expect(updatedRepoInput.value).toBe('');
    });
  });
});
