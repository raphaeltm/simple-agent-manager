import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

const mocks = vi.hoisted(() => ({
  createWorkspace: vi.fn(),
  listCredentials: vi.fn(),
  listGitHubInstallations: vi.fn(),
  listNodes: vi.fn(),
  listRepositories: vi.fn(),
  listBranches: vi.fn(),
}));

vi.mock('../../../src/lib/api', () => ({
  createWorkspace: mocks.createWorkspace,
  listCredentials: mocks.listCredentials,
  listGitHubInstallations: mocks.listGitHubInstallations,
  listNodes: mocks.listNodes,
  listRepositories: mocks.listRepositories,
  listBranches: mocks.listBranches,
}));

vi.mock('../../../src/components/UserMenu', () => ({
  UserMenu: () => <div data-testid="user-menu" />,
}));

import { CreateWorkspace } from '../../../src/pages/CreateWorkspace';

function renderCreateWorkspace() {
  return render(
    <MemoryRouter initialEntries={['/create']}>
      <Routes>
        <Route path="/create" element={<CreateWorkspace />} />
        <Route path="/workspaces/:id" element={<div data-testid="workspace-detail" />} />
        <Route path="/settings" element={<div data-testid="settings" />} />
        <Route path="/dashboard" element={<div data-testid="dashboard" />} />
      </Routes>
    </MemoryRouter>
  );
}

describe('CreateWorkspace', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mocks.listCredentials.mockResolvedValue([
      { provider: 'hetzner', createdAt: '2026-01-01T00:00:00Z' },
    ]);
    mocks.listGitHubInstallations.mockResolvedValue([
      {
        id: 'inst-1',
        userId: 'user-1',
        installationId: '12345',
        accountType: 'personal',
        accountName: 'octo',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      },
    ]);
    mocks.listNodes.mockResolvedValue([]);
    mocks.listRepositories.mockResolvedValue([
      {
        id: 1,
        fullName: 'octo/my-repo',
        name: 'my-repo',
        private: false,
        defaultBranch: 'main',
        installationId: 'inst-1',
      },
    ]);
    mocks.listBranches.mockResolvedValue([
      { name: 'main' },
      { name: 'develop' },
      { name: 'feature/cool-thing' },
    ]);
  });

  it('renders the create workspace form when prerequisites are met', async () => {
    renderCreateWorkspace();
    const nameInput = await screen.findByLabelText('Workspace Name');
    expect(nameInput).toBeInTheDocument();
    expect(screen.getByLabelText('Branch')).toBeInTheDocument();
  });

  it('shows branch dropdown after selecting a repository', async () => {
    renderCreateWorkspace();
    await screen.findByLabelText('Workspace Name');

    // Type in the repo input to trigger the dropdown
    const repoInput = screen.getByLabelText('Repository');
    fireEvent.change(repoInput, { target: { value: 'my-repo' } });
    fireEvent.focus(repoInput);

    // Select the repo from dropdown
    const repoOption = await screen.findByText('octo/my-repo');
    fireEvent.click(repoOption);

    // Wait for branches to load and verify the branch selector becomes a dropdown
    await waitFor(() => {
      expect(mocks.listBranches).toHaveBeenCalledWith('octo/my-repo', 'inst-1');
    });

    // The branch field should now be a select with the options
    await waitFor(() => {
      const branchSelect = screen.getByLabelText('Branch');
      expect(branchSelect.tagName).toBe('SELECT');
    });

    // Check that the branch options are present
    const options = screen.getAllByRole('option');
    const branchOptions = options.filter(
      (opt) => ['main', 'develop', 'feature/cool-thing'].includes(opt.textContent ?? '')
    );
    expect(branchOptions).toHaveLength(3);
  });

  it('defaults branch to repository default branch when selected', async () => {
    renderCreateWorkspace();
    await screen.findByLabelText('Workspace Name');

    const repoInput = screen.getByLabelText('Repository');
    fireEvent.change(repoInput, { target: { value: 'my-repo' } });
    fireEvent.focus(repoInput);

    const repoOption = await screen.findByText('octo/my-repo');
    fireEvent.click(repoOption);

    await waitFor(() => {
      expect(mocks.listBranches).toHaveBeenCalled();
    });

    await waitFor(() => {
      const branchSelect = screen.getByLabelText('Branch') as HTMLSelectElement;
      expect(branchSelect.value).toBe('main');
    });
  });

  it('falls back to text input when no branches are loaded', async () => {
    mocks.listBranches.mockResolvedValue([]);

    renderCreateWorkspace();
    await screen.findByLabelText('Workspace Name');

    // Without selecting a repo, the branch field should be a text input
    const branchInput = screen.getByLabelText('Branch');
    expect(branchInput.tagName).toBe('INPUT');
    expect((branchInput as HTMLInputElement).value).toBe('main');
  });

  it('shows setup required when hetzner credentials are missing', async () => {
    mocks.listCredentials.mockResolvedValue([]);

    renderCreateWorkspace();
    expect(await screen.findByText('Setup Required')).toBeInTheDocument();
  });
});
