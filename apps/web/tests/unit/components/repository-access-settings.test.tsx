import type {
  Project,
  ProjectRepository,
  ProjectRepositoryStatus,
  SubmoduleSuggestion,
} from '@simple-agent-manager/shared';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  listProjectRepositories: vi.fn(),
  addProjectRepository: vi.fn(),
  removeProjectRepository: vi.fn(),
  discoverSubmoduleRepos: vi.fn(),
}));

vi.mock('../../../src/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/lib/api')>()),
  listProjectRepositories: mocks.listProjectRepositories,
  addProjectRepository: mocks.addProjectRepository,
  removeProjectRepository: mocks.removeProjectRepository,
  discoverSubmoduleRepos: mocks.discoverSubmoduleRepos,
}));

const mockToast = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
}));

vi.mock('../../../src/hooks/useToast', () => ({
  useToast: () => mockToast,
}));

import { RepositoryAccessSettings } from '../../../src/components/RepositoryAccessSettings';

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 'proj-1',
    userId: 'user-1',
    name: 'SAM',
    description: null,
    installationId: '120081765',
    repository: 'raph/sam',
    defaultBranch: 'main',
    repoProvider: 'github',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeRepo(overrides: Partial<ProjectRepository> = {}): ProjectRepository {
  return {
    id: 'repo-1',
    repository: 'acme/shared-lib',
    githubRepoId: 7,
    githubRepoNodeId: null,
    status: 'active' as ProjectRepositoryStatus,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeSuggestion(overrides: Partial<SubmoduleSuggestion> = {}): SubmoduleSuggestion {
  return {
    repository: 'acme/vendor-lib',
    path: 'vendor/lib',
    accessible: true,
    alreadyAdded: false,
    ...overrides,
  };
}

describe('RepositoryAccessSettings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listProjectRepositories.mockResolvedValue({
      primaryRepository: 'raph/sam',
      repositories: [],
    });
  });

  it('renders nothing for non-GitHub-backed projects', () => {
    const { container } = render(
      <RepositoryAccessSettings project={makeProject({ repoProvider: 'artifacts' })} />
    );
    expect(container).toBeEmptyDOMElement();
    expect(mocks.listProjectRepositories).not.toHaveBeenCalled();
  });

  it('loads and displays the always-included primary repository', async () => {
    mocks.listProjectRepositories.mockResolvedValue({
      primaryRepository: 'raph/sam',
      repositories: [],
    });

    render(<RepositoryAccessSettings project={makeProject()} />);

    await waitFor(() => {
      expect(mocks.listProjectRepositories).toHaveBeenCalledWith('proj-1');
    });
    expect(screen.getByText('raph/sam')).toBeInTheDocument();
    expect(screen.getByText('always included')).toBeInTheDocument();
    expect(screen.getByText(/No additional repositories\./)).toBeInTheDocument();
  });

  it('shows an error toast when loading repository access fails', async () => {
    mocks.listProjectRepositories.mockRejectedValue(new Error('boom'));

    render(<RepositoryAccessSettings project={makeProject()} />);

    await waitFor(() => {
      expect(mockToast.error).toHaveBeenCalledWith('Failed to load repository access');
    });
  });

  it('renders additional repositories with their access status badge', async () => {
    mocks.listProjectRepositories.mockResolvedValue({
      primaryRepository: 'raph/sam',
      repositories: [
        makeRepo({ id: 'r1', repository: 'acme/shared-lib', status: 'active' }),
        makeRepo({ id: 'r2', repository: 'acme/revoked-lib', status: 'access-revoked' }),
      ],
    });

    render(<RepositoryAccessSettings project={makeProject()} />);

    await waitFor(() => {
      expect(screen.getByText('acme/shared-lib')).toBeInTheDocument();
    });
    expect(screen.getByText('acme/revoked-lib')).toBeInTheDocument();
    expect(screen.getByText('active')).toBeInTheDocument();
    expect(screen.getByText('access revoked')).toBeInTheDocument();
  });

  it('adds a repository via the input and reflects the updated set', async () => {
    mocks.addProjectRepository.mockResolvedValue({
      primaryRepository: 'raph/sam',
      repositories: [makeRepo({ id: 'r1', repository: 'acme/new-lib' })],
    });

    render(<RepositoryAccessSettings project={makeProject()} />);
    await waitFor(() => expect(mocks.listProjectRepositories).toHaveBeenCalled());

    const input = screen.getByLabelText('Additional repository') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '  acme/new-lib  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));

    await waitFor(() => {
      expect(mocks.addProjectRepository).toHaveBeenCalledWith('proj-1', {
        repository: 'acme/new-lib',
      });
    });
    expect(mockToast.success).toHaveBeenCalledWith('Added acme/new-lib');
    await waitFor(() => {
      expect(screen.getByText('acme/new-lib')).toBeInTheDocument();
    });
    // Input cleared after a successful add.
    expect(input.value).toBe('');
  });

  it('rejects an empty repository submission without calling the API', async () => {
    render(<RepositoryAccessSettings project={makeProject()} />);
    await waitFor(() => expect(mocks.listProjectRepositories).toHaveBeenCalled());

    const input = screen.getByLabelText('Additional repository') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '   ' } });
    // Enter submits the value too.
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(mocks.addProjectRepository).not.toHaveBeenCalled();
    expect(mockToast.error).toHaveBeenCalledWith('Repository is required');
  });

  it('surfaces the API error message when an add fails', async () => {
    mocks.addProjectRepository.mockRejectedValue(
      new Error('Repository is not accessible through the selected installation')
    );

    render(<RepositoryAccessSettings project={makeProject()} />);
    await waitFor(() => expect(mocks.listProjectRepositories).toHaveBeenCalled());

    const input = screen.getByLabelText('Additional repository');
    fireEvent.change(input, { target: { value: 'acme/forbidden' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));

    await waitFor(() => {
      expect(mockToast.error).toHaveBeenCalledWith(
        'Repository is not accessible through the selected installation'
      );
    });
  });

  it('removes a repository and reflects the updated set', async () => {
    mocks.listProjectRepositories.mockResolvedValue({
      primaryRepository: 'raph/sam',
      repositories: [makeRepo({ id: 'r1', repository: 'acme/shared-lib' })],
    });
    mocks.removeProjectRepository.mockResolvedValue({
      primaryRepository: 'raph/sam',
      repositories: [],
    });

    render(<RepositoryAccessSettings project={makeProject()} />);
    await waitFor(() => {
      expect(screen.getByText('acme/shared-lib')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Remove acme/shared-lib' }));

    await waitFor(() => {
      expect(mocks.removeProjectRepository).toHaveBeenCalledWith('proj-1', 'r1');
    });
    expect(mockToast.success).toHaveBeenCalledWith('Removed acme/shared-lib');
    await waitFor(() => {
      expect(screen.queryByText('acme/shared-lib')).not.toBeInTheDocument();
    });
  });

  it('discovers submodule suggestions and adds an accessible one', async () => {
    mocks.discoverSubmoduleRepos.mockResolvedValue({
      suggestions: [
        makeSuggestion({ repository: 'acme/vendor-lib', path: 'vendor/lib', accessible: true }),
        makeSuggestion({ repository: 'acme/no-access', path: 'vendor/blocked', accessible: false }),
      ],
    });
    mocks.addProjectRepository.mockResolvedValue({
      primaryRepository: 'raph/sam',
      repositories: [makeRepo({ id: 'r1', repository: 'acme/vendor-lib' })],
    });

    render(<RepositoryAccessSettings project={makeProject()} />);
    await waitFor(() => expect(mocks.listProjectRepositories).toHaveBeenCalled());

    fireEvent.click(screen.getByRole('button', { name: 'Discover from .gitmodules' }));

    await waitFor(() => {
      expect(screen.getByText('acme/vendor-lib')).toBeInTheDocument();
    });
    // Inaccessible suggestion is shown but cannot be added.
    expect(screen.getByText('acme/no-access')).toBeInTheDocument();
    expect(screen.getByText('no access')).toBeInTheDocument();

    // The accessible suggestion row exposes an Add button; click it.
    const vendorRow = screen.getByText('acme/vendor-lib').closest('div') as HTMLElement;
    fireEvent.click(within(vendorRow).getByRole('button', { name: 'Add' }));

    await waitFor(() => {
      expect(mocks.addProjectRepository).toHaveBeenCalledWith('proj-1', {
        repository: 'acme/vendor-lib',
      });
    });
  });

  it('reports when no submodules are declared in the primary repository', async () => {
    mocks.discoverSubmoduleRepos.mockResolvedValue({ suggestions: [] });

    render(<RepositoryAccessSettings project={makeProject()} />);
    await waitFor(() => expect(mocks.listProjectRepositories).toHaveBeenCalled());

    fireEvent.click(screen.getByRole('button', { name: 'Discover from .gitmodules' }));

    await waitFor(() => {
      expect(mockToast.success).toHaveBeenCalledWith(
        'No submodules found in the primary repository'
      );
    });
    expect(
      screen.getByText('No submodules declared in the primary repository.')
    ).toBeInTheDocument();
  });
});
