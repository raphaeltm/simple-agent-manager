import type { ProjectSummary } from '@simple-agent-manager/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ToastProvider } from '../../../src/hooks/useToast';

const mocks = vi.hoisted(() => ({
  useProjectList: vi.fn(),
  deleteProject: vi.fn(),
}));

vi.mock('../../../src/hooks/useProjectData', () => ({
  useProjectList: mocks.useProjectList,
}));

vi.mock('../../../src/components/AuthProvider', () => ({
  useAuth: () => ({ user: { id: 'user-1', email: 'owner@example.com', name: 'Project Owner' } }),
}));

vi.mock('../../../src/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/lib/api')>()),
  deleteProject: mocks.deleteProject,
}));

vi.mock('../../../src/components/UserMenu', () => ({
  UserMenu: () => <div data-testid="user-menu">user-menu</div>,
}));

import { Projects } from '../../../src/pages/Projects';

const PROJECT_SUMMARY = {
  id: 'proj-1',
  name: 'Project One',
  repository: 'acme/repo-one',
  githubRepoId: 101,
  defaultBranch: 'main',
  repoProvider: 'github',
  status: 'active',
  activeWorkspaceCount: 2,
  activeSessionCount: 1,
  lastActivityAt: '2026-02-18T12:00:00.000Z',
  taskCountsByStatus: {},
  linkedWorkspaces: 2,
  createdAt: '2026-02-18T00:00:00.000Z',
} satisfies ProjectSummary;

function renderPage() {
  const queryClient = new QueryClient();
  return render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <MemoryRouter initialEntries={['/projects']}>
          <Routes>
            <Route path="/projects" element={<Projects />} />
            <Route path="/projects/new" element={<div data-testid="project-create-page">create</div>} />
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>
  );
}

describe('Projects page', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mocks.useProjectList.mockReturnValue({
      projects: [PROJECT_SUMMARY],
      loading: false,
      isRefreshing: false,
      error: null,
      refresh: vi.fn(),
    });
  });

  it('loads and renders projects using ProjectSummaryCard', async () => {
    renderPage();

    expect(await screen.findByText('Project One')).toBeInTheDocument();
    expect(screen.getByText(/acme\/repo-one/)).toBeInTheDocument();
  });

  it('renders New Project button', async () => {
    renderPage();

    expect(screen.getByRole('button', { name: 'New Project' })).toBeInTheDocument();
  });

  it('shows empty state when no projects', async () => {
    mocks.useProjectList.mockReturnValue({
      projects: [],
      loading: false,
      isRefreshing: false,
      error: null,
      refresh: vi.fn(),
    });
    renderPage();

    await waitFor(() => {
      expect(screen.getByText('No projects yet')).toBeInTheDocument();
    });
  });

  it('shows error when loading fails', async () => {
    mocks.useProjectList.mockReturnValue({
      projects: [],
      loading: false,
      isRefreshing: false,
      error: 'Network error',
      refresh: vi.fn(),
    });
    renderPage();

    await waitFor(() => {
      expect(screen.getByText('Network error')).toBeInTheDocument();
    });
    expect(screen.queryByText('No projects yet')).not.toBeInTheDocument();
  });

  it('shows skeleton cards during loading', () => {
    mocks.useProjectList.mockReturnValue({
      projects: [],
      loading: true,
      isRefreshing: false,
      error: null,
      refresh: vi.fn(),
    });
    renderPage();

    // SkeletonCard renders skeleton elements
    expect(screen.queryByText('No projects yet')).not.toBeInTheDocument();
    expect(screen.queryByText('Project One')).not.toBeInTheDocument();
  });

  it('shows workspace and session counts with singular/plural forms', async () => {
    renderPage();

    // 2 workspaces · 1 session — counts are pluralized ("1 session", not
    // "1 sessions") and zero-count segments are hidden entirely.
    expect(await screen.findByText(/2 ws · 1 session$/)).toBeInTheDocument();
  });
});
