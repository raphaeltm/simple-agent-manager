import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ToastProvider } from '../../../src/hooks/useToast';

const mocks = vi.hoisted(() => ({
  listProjects: vi.fn(),
}));

vi.mock('../../../src/lib/api', () => ({
  listProjects: mocks.listProjects,
}));

vi.mock('../../../src/components/UserMenu', () => ({
  UserMenu: () => <div data-testid="user-menu">user-menu</div>,
}));

import { Projects } from '../../../src/pages/Projects';

function renderPage() {
  return render(
    <ToastProvider>
      <MemoryRouter initialEntries={['/projects']}>
        <Routes>
          <Route path="/projects" element={<Projects />} />
          <Route path="/projects/new" element={<div data-testid="project-create-page">create</div>} />
        </Routes>
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
  });

  it('loads and renders projects', async () => {
    renderPage();

    await waitFor(() => {
      expect(mocks.listProjects).toHaveBeenCalled();
    });

    expect(await screen.findByText('Project One')).toBeInTheDocument();
    expect(screen.getByText('acme/repo-one@main')).toBeInTheDocument();
  });

  it('renders New Project button that links to /projects/new', async () => {
    renderPage();

    await waitFor(() => {
      expect(mocks.listProjects).toHaveBeenCalled();
    });

    expect(screen.getByRole('button', { name: 'New Project' })).toBeInTheDocument();
  });

  it('shows empty state when no projects', async () => {
    mocks.listProjects.mockResolvedValue({ projects: [], nextCursor: null });
    renderPage();

    await waitFor(() => {
      expect(screen.getByText('No projects yet')).toBeInTheDocument();
    });
  });

  it('shows error when loading fails', async () => {
    mocks.listProjects.mockRejectedValue(new Error('Network error'));
    renderPage();

    await waitFor(() => {
      expect(screen.getByText('Network error')).toBeInTheDocument();
    });
  });
});
