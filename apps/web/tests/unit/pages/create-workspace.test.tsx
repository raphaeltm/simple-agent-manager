import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

const mocks = vi.hoisted(() => ({
  createWorkspace: vi.fn(),
  listCredentials: vi.fn(),
  listGitHubInstallations: vi.fn(),
  listNodes: vi.fn(),
  listRepositories: vi.fn(),
  listBranches: vi.fn(),
  getProviderCatalog: vi.fn(),
  listProjects: vi.fn(),
  getProject: vi.fn(),
}));

vi.mock('../../../src/lib/api', () => ({
  createWorkspace: mocks.createWorkspace,
  listCredentials: mocks.listCredentials,
  listGitHubInstallations: mocks.listGitHubInstallations,
  listNodes: mocks.listNodes,
  listRepositories: mocks.listRepositories,
  listBranches: mocks.listBranches,
  getProviderCatalog: mocks.getProviderCatalog,
  listProjects: mocks.listProjects,
  getProject: mocks.getProject,
}));

vi.mock('../../../src/components/UserMenu', () => ({
  UserMenu: () => <div data-testid="user-menu" />,
}));

import { CreateWorkspace } from '../../../src/pages/CreateWorkspace';

const DEFAULT_PROJECT_STATE = {
  projectId: 'proj-1',
};

function renderCreateWorkspace(locationState: Record<string, unknown> = DEFAULT_PROJECT_STATE) {
  return render(
    <MemoryRouter initialEntries={[{ pathname: '/create', state: locationState }]}>
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
    mocks.listRepositories.mockResolvedValue({
      repositories: [
        {
          id: 1,
          fullName: 'octo/my-repo',
          name: 'my-repo',
          private: false,
          defaultBranch: 'main',
          installationId: 'inst-1',
        },
      ],
    });
    mocks.listBranches.mockResolvedValue([
      { name: 'main' },
      { name: 'develop' },
      { name: 'feature/cool-thing' },
    ]);
    mocks.getProviderCatalog.mockResolvedValue({ catalogs: [] });
    mocks.listProjects.mockResolvedValue({ projects: [{ id: 'proj-1', name: 'My Project' }] });
    mocks.getProject.mockResolvedValue({
      id: 'proj-1',
      name: 'My Project',
      repository: null,
      defaultBranch: null,
      installationId: 'inst-1',
      defaultVmSize: null,
    });
  });

  it('renders the create workspace form when prerequisites are met', async () => {
    renderCreateWorkspace();
    const nameInput = await screen.findByLabelText('Workspace Name');
    expect(nameInput).toBeInTheDocument();
    expect(screen.getByLabelText('Branch')).toBeInTheDocument();
  });

  it('shows repository as read-only when linked to a project', async () => {
    // When workspace is linked to a project, repo comes from the project
    mocks.getProject.mockResolvedValue({
      id: 'proj-1',
      name: 'My Project',
      repository: 'octo/my-repo',
      defaultBranch: 'main',
      installationId: 'inst-1',
      defaultVmSize: null,
    });

    renderCreateWorkspace();
    await screen.findByLabelText('Workspace Name');

    // Repository should be a read-only input, not a RepoSelector
    await waitFor(() => {
      const repoInput = screen.getByLabelText('Repository') as HTMLInputElement;
      expect(repoInput.readOnly).toBe(true);
      expect(repoInput.value).toBe('octo/my-repo');
    });
  });

  it('pre-fills branch from project default branch', async () => {
    mocks.getProject.mockResolvedValue({
      id: 'proj-1',
      name: 'My Project',
      repository: 'octo/my-repo',
      defaultBranch: 'develop',
      installationId: 'inst-1',
      defaultVmSize: null,
    });

    renderCreateWorkspace();
    await screen.findByLabelText('Workspace Name');

    await waitFor(() => {
      const branchInput = screen.getByLabelText('Branch') as HTMLInputElement;
      expect(branchInput.value).toBe('develop');
    });
  });

  it('fetches branches for the project repository on load', async () => {
    mocks.getProject.mockResolvedValue({
      id: 'proj-1',
      name: 'My Project',
      repository: 'octo/my-repo',
      defaultBranch: 'main',
      installationId: 'inst-1',
      defaultVmSize: null,
    });

    renderCreateWorkspace();
    await screen.findByLabelText('Workspace Name');

    await waitFor(() => {
      expect(mocks.listBranches).toHaveBeenCalledWith('octo/my-repo', 'inst-1', 'main');
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

  it('shows prerequisites checklist with loading states initially', async () => {
    // Use never-resolving promises so we can observe the loading state
    mocks.listCredentials.mockReturnValue(new Promise(() => {}));
    mocks.listGitHubInstallations.mockReturnValue(new Promise(() => {}));
    mocks.listNodes.mockReturnValue(new Promise(() => {}));

    renderCreateWorkspace();

    expect(await screen.findByText('Checking prerequisites...')).toBeInTheDocument();
    expect(screen.getByText('Cloud Provider')).toBeInTheDocument();
    expect(screen.getByText('GitHub App Installation')).toBeInTheDocument();
    expect(screen.getByText('Nodes')).toBeInTheDocument();
  });

  it('shows individual prereq status as each resolves', async () => {
    // Hetzner ready, GitHub missing
    mocks.listCredentials.mockResolvedValue([
      { provider: 'hetzner', createdAt: '2026-01-01T00:00:00Z' },
    ]);
    mocks.listGitHubInstallations.mockResolvedValue([]);
    mocks.listNodes.mockResolvedValue([]);

    renderCreateWorkspace();

    // Hetzner shows Connected, GitHub shows missing
    expect(await screen.findByText('Connected')).toBeInTheDocument();
    expect(await screen.findByText('Required to access repositories')).toBeInTheDocument();
    // Settings button should appear for missing GitHub
    const settingsButtons = screen.getAllByRole('button', { name: 'Settings' });
    expect(settingsButtons.length).toBeGreaterThanOrEqual(1);
  });

  it('shows node count in prerequisites when prereqs card is visible', async () => {
    // Make GitHub missing so prereqs card stays visible
    mocks.listGitHubInstallations.mockResolvedValue([]);
    mocks.listNodes.mockResolvedValue([
      { id: 'n1', name: 'node-1', status: 'running' },
      { id: 'n2', name: 'node-2', status: 'running' },
    ]);

    renderCreateWorkspace();

    expect(await screen.findByText('2 available nodes')).toBeInTheDocument();
  });

  it('hides prerequisites checklist once all are met', async () => {
    // All prerequisites met (default mocks)
    renderCreateWorkspace();

    // Form should appear
    const nameInput = await screen.findByLabelText('Workspace Name');
    expect(nameInput).toBeInTheDocument();

    // Prerequisites checklist should not be visible (all passed, not in loading/missing state)
    expect(screen.queryByText('Setup Required')).not.toBeInTheDocument();
    expect(screen.queryByText('Checking prerequisites...')).not.toBeInTheDocument();
  });

  it('loads project details and pre-fills workspace name from project', async () => {
    mocks.getProject.mockResolvedValue({
      id: 'proj-1',
      name: 'My Project',
      repository: 'octo/my-repo',
      defaultBranch: 'main',
      installationId: 'inst-1',
      defaultVmSize: null,
    });

    renderCreateWorkspace();

    // Workspace name should be pre-filled from project
    await waitFor(() => {
      const nameInput = screen.getByLabelText('Workspace Name') as HTMLInputElement;
      expect(nameInput.value).toBe('My Project Workspace');
    });

    // getProject should have been called with the project ID from location state
    expect(mocks.getProject).toHaveBeenCalledWith('proj-1');
  });

});
