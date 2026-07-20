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
  listAvailableRepositories: vi.fn(),
}));

vi.mock('../../../src/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/lib/api')>()),
  listProjectRepositories: mocks.listProjectRepositories,
  addProjectRepository: mocks.addProjectRepository,
  removeProjectRepository: mocks.removeProjectRepository,
  discoverSubmoduleRepos: mocks.discoverSubmoduleRepos,
  listAvailableRepositories: mocks.listAvailableRepositories,
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

async function findAdditionalRepositoryInput(): Promise<HTMLInputElement> {
  return (await screen.findByLabelText('Additional repository')) as HTMLInputElement;
}

describe('RepositoryAccessSettings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listProjectRepositories.mockResolvedValue({
      primaryRepository: 'raph/sam',
      repositories: [],
    });
    // The combobox lazy-loads the user∩app intersection on first open.
    mocks.listAvailableRepositories.mockResolvedValue({ repositories: [] });
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
    expect(await screen.findByText('raph/sam')).toBeInTheDocument();
    expect(screen.getByText('always included')).toBeInTheDocument();
    expect(screen.getByText(/No additional repositories\./)).toBeInTheDocument();
  });

  it('shows an inline error when loading repository access fails (stale-while-revalidate)', async () => {
    mocks.listProjectRepositories.mockRejectedValue(new Error('boom'));

    render(<RepositoryAccessSettings project={makeProject()} />);

    // Error is rendered inline, not via toast (stale-while-revalidate pattern)
    await waitFor(() => {
      expect(screen.getByText('Failed to load repository access')).toBeInTheDocument();
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

  it('adds a repository via the combobox and reflects the updated set', async () => {
    mocks.addProjectRepository.mockResolvedValue({
      primaryRepository: 'raph/sam',
      repositories: [makeRepo({ id: 'r1', repository: 'acme/new-lib' })],
    });

    render(<RepositoryAccessSettings project={makeProject()} />);

    const input = await findAdditionalRepositoryInput();
    fireEvent.change(input, { target: { value: '  acme/new-lib  ' } });
    // Pressing Enter commits the typed owner/repo as a manual entry.
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => {
      expect(mocks.addProjectRepository).toHaveBeenCalledWith('proj-1', {
        repository: 'acme/new-lib',
      });
    });
    expect(mockToast.success).toHaveBeenCalledWith('Added acme/new-lib');
    await waitFor(() => {
      expect(screen.getByText('acme/new-lib')).toBeInTheDocument();
    });
    // Combobox clears its query after a successful add.
    expect(input.value).toBe('');
  });

  it('ignores an empty repository submission without calling the API', async () => {
    render(<RepositoryAccessSettings project={makeProject()} />);

    const input = await findAdditionalRepositoryInput();
    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    // The combobox does not commit blank/whitespace-only input.
    expect(mocks.addProjectRepository).not.toHaveBeenCalled();
  });

  it('surfaces the API error message when an add fails', async () => {
    mocks.addProjectRepository.mockRejectedValue(
      new Error('Repository is not accessible through the selected installation')
    );

    render(<RepositoryAccessSettings project={makeProject()} />);

    const input = await findAdditionalRepositoryInput();
    fireEvent.change(input, { target: { value: 'acme/forbidden' } });
    fireEvent.keyDown(input, { key: 'Enter' });

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

    fireEvent.click(await screen.findByRole('button', { name: 'Discover from .gitmodules' }));

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

    fireEvent.click(await screen.findByRole('button', { name: 'Discover from .gitmodules' }));

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
