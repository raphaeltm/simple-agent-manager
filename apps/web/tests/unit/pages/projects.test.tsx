import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '../../../src/hooks/useToast';

const mocks = vi.hoisted(() => ({
  listProjects: vi.fn(),
  listGitHubInstallations: vi.fn(),
  createProject: vi.fn(),
}));

vi.mock('../../../src/lib/api', () => ({
  listProjects: mocks.listProjects,
  listGitHubInstallations: mocks.listGitHubInstallations,
  createProject: mocks.createProject,
}));

vi.mock('../../../src/components/UserMenu', () => ({
  UserMenu: () => <div data-testid="user-menu">user-menu</div>,
}));

import { Projects } from '../../../src/pages/Projects';

function renderPage() {
  return render(
    <ToastProvider>
      <MemoryRouter>
        <Projects />
      </MemoryRouter>
    </ToastProvider>
  );
}

describe('Projects page', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mocks.listProjects.mockResolvedValue({
      projects: [
        {
          id: 'proj-1',
          userId: 'user-1',
          name: 'Project One',
          description: 'First project',
          installationId: 'inst-1',
          repository: 'acme/repo-one',
          defaultBranch: 'main',
          createdAt: '2026-02-18T00:00:00.000Z',
          updatedAt: '2026-02-18T00:00:00.000Z',
        },
      ],
      nextCursor: null,
    });

    mocks.listGitHubInstallations.mockResolvedValue([
      {
        id: 'inst-1',
        userId: 'user-1',
        installationId: '123',
        accountType: 'personal',
        accountName: 'octocat',
        createdAt: '2026-02-18T00:00:00.000Z',
        updatedAt: '2026-02-18T00:00:00.000Z',
      },
    ]);

    mocks.createProject.mockResolvedValue({
      id: 'proj-new',
      userId: 'user-1',
      name: 'New Project',
      description: null,
      installationId: 'inst-1',
      repository: 'acme/new-repo',
      defaultBranch: 'main',
      createdAt: '2026-02-18T00:00:00.000Z',
      updatedAt: '2026-02-18T00:00:00.000Z',
    });
  });

  it('loads and renders projects', async () => {
    renderPage();

    await waitFor(() => {
      expect(mocks.listProjects).toHaveBeenCalled();
      expect(mocks.listGitHubInstallations).toHaveBeenCalled();
    });

    expect(await screen.findByText('Project One')).toBeInTheDocument();
    expect(screen.getByText('acme/repo-one@main')).toBeInTheDocument();
  });

  it('creates a project from the form', async () => {
    renderPage();

    fireEvent.click(screen.getByRole('button', { name: 'New Project' }));

    await waitFor(() => {
      expect(screen.getByText('Create project')).toBeInTheDocument();
    });

    fireEvent.change(screen.getByPlaceholderText('Project name'), { target: { value: 'New Project' } });
    fireEvent.change(screen.getByPlaceholderText('owner/repo'), { target: { value: 'acme/new-repo' } });

    fireEvent.click(screen.getByRole('button', { name: 'Create Project' }));

    await waitFor(() => {
      expect(mocks.createProject).toHaveBeenCalledWith({
        name: 'New Project',
        description: undefined,
        installationId: 'inst-1',
        repository: 'acme/new-repo',
        defaultBranch: 'main',
      });
    });
  });
});
