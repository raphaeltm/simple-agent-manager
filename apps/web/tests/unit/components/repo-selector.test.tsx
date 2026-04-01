import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  listRepositories: vi.fn(),
}));

vi.mock('../../../src/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/lib/api')>()),
  listRepositories: mocks.listRepositories,
}));

import { RepoSelector } from '../../../src/components/RepoSelector';

const personalRepos = {
  repositories: [
    {
      id: 1,
      fullName: 'user/personal-repo',
      name: 'personal-repo',
      private: false,
      defaultBranch: 'main',
      installationId: 'inst-personal',
    },
    {
      id: 2,
      fullName: 'user/another-repo',
      name: 'another-repo',
      private: true,
      defaultBranch: 'develop',
      installationId: 'inst-personal',
    },
  ],
};

const orgRepos = {
  repositories: [
    {
      id: 10,
      fullName: 'my-org/org-repo',
      name: 'org-repo',
      private: false,
      defaultBranch: 'main',
      installationId: 'inst-org',
    },
    {
      id: 11,
      fullName: 'my-org/private-service',
      name: 'private-service',
      private: true,
      defaultBranch: 'main',
      installationId: 'inst-org',
    },
  ],
};

describe('RepoSelector', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listRepositories.mockResolvedValue(personalRepos);
  });

  it('fetches repos on mount and shows them on focus', async () => {
    render(
      <RepoSelector value="" onChange={() => {}} />
    );

    await waitFor(() => {
      expect(mocks.listRepositories).toHaveBeenCalledWith(undefined);
    });

    fireEvent.focus(screen.getByRole('textbox'));
    expect(await screen.findByText('user/personal-repo')).toBeInTheDocument();
    expect(screen.getByText('user/another-repo')).toBeInTheDocument();
  });

  it('passes installationId to listRepositories when provided', async () => {
    mocks.listRepositories.mockResolvedValue(orgRepos);

    render(
      <RepoSelector value="" onChange={() => {}} installationId="inst-org" />
    );

    await waitFor(() => {
      expect(mocks.listRepositories).toHaveBeenCalledWith('inst-org');
    });

    fireEvent.focus(screen.getByRole('textbox'));
    expect(await screen.findByText('my-org/org-repo')).toBeInTheDocument();
    expect(screen.getByText('my-org/private-service')).toBeInTheDocument();
  });

  it('re-fetches repos when installationId changes', async () => {
    mocks.listRepositories
      .mockResolvedValueOnce(personalRepos)
      .mockResolvedValueOnce(orgRepos);

    const { rerender } = render(
      <RepoSelector value="" onChange={() => {}} installationId="inst-personal" />
    );

    await waitFor(() => {
      expect(mocks.listRepositories).toHaveBeenCalledWith('inst-personal');
    });

    // Change installation
    rerender(
      <RepoSelector value="" onChange={() => {}} installationId="inst-org" />
    );

    await waitFor(() => {
      expect(mocks.listRepositories).toHaveBeenCalledWith('inst-org');
    });

    fireEvent.focus(screen.getByRole('textbox'));
    expect(await screen.findByText('my-org/org-repo')).toBeInTheDocument();
  });

  it('shows warning when some installations fail to fetch', async () => {
    mocks.listRepositories.mockResolvedValue({
      repositories: personalRepos.repositories,
      failedInstallations: ['my-org'],
    });

    render(
      <RepoSelector value="" onChange={() => {}} />
    );

    expect(await screen.findByText(/Could not load repos from: my-org/)).toBeInTheDocument();
  });

  it('calls onRepoSelect when a repo is clicked', async () => {
    const onRepoSelect = vi.fn();
    const onChange = vi.fn();

    render(
      <RepoSelector
        value=""
        onChange={onChange}
        onRepoSelect={onRepoSelect}
      />
    );

    await waitFor(() => {
      expect(mocks.listRepositories).toHaveBeenCalled();
    });

    fireEvent.focus(screen.getByRole('textbox'));
    const option = await screen.findByText('user/personal-repo');
    fireEvent.click(option);

    expect(onChange).toHaveBeenCalledWith('https://github.com/user/personal-repo');
    expect(onRepoSelect).toHaveBeenCalledWith({
      fullName: 'user/personal-repo',
      defaultBranch: 'main',
      githubRepoId: 1,
    });
  });

  it('filters repos based on typed input', async () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <RepoSelector value="" onChange={onChange} />
    );

    await waitFor(() => {
      expect(mocks.listRepositories).toHaveBeenCalled();
    });

    // Simulate typing "another"
    rerender(
      <RepoSelector value="another" onChange={onChange} />
    );

    fireEvent.focus(screen.getByRole('textbox'));

    await waitFor(() => {
      expect(screen.getByText('user/another-repo')).toBeInTheDocument();
      expect(screen.queryByText('user/personal-repo')).not.toBeInTheDocument();
    });
  });

  it('hides dropdown when value is a URL', async () => {
    const { rerender } = render(
      <RepoSelector value="" onChange={() => {}} />
    );

    await waitFor(() => {
      expect(mocks.listRepositories).toHaveBeenCalled();
    });

    rerender(
      <RepoSelector value="https://github.com/user/personal-repo" onChange={() => {}} />
    );

    fireEvent.focus(screen.getByRole('textbox'));

    // Dropdown should not show when value is a URL
    expect(screen.queryByText('user/personal-repo')).not.toBeInTheDocument();
  });
});
