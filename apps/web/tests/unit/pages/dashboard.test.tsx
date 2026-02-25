import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const mocks = vi.hoisted(() => ({
  listProjects: vi.fn(),
}));

vi.mock('../../../src/lib/api', () => ({
  listProjects: mocks.listProjects,
}));

vi.mock('../../../src/components/AuthProvider', () => ({
  useAuth: () => ({
    user: {
      id: 'user_123',
      email: 'dev@example.com',
      name: 'Dev User',
    },
  }),
}));

vi.mock('../../../src/components/UserMenu', () => ({
  UserMenu: () => <div data-testid="user-menu">user-menu</div>,
}));

vi.mock('../../../src/hooks/useProjectData', () => ({
  useProjectList: (opts: unknown) => {
    const result = mocks.listProjects(opts);
    return {
      projects: result?.projects ?? [],
      loading: false,
      error: null,
      refresh: vi.fn(),
    };
  },
}));

vi.mock('../../../src/components/ProjectSummaryCard', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ProjectSummaryCard: ({ project }: any) => (
    <div data-testid="project-summary-card">{project.name}</div>
  ),
}));

import { Dashboard } from '../../../src/pages/Dashboard';
import { ToastProvider } from '../../../src/hooks/useToast';

const sampleProject = {
  id: 'proj-1',
  name: 'Project One',
  repository: 'acme/repo-one',
  defaultBranch: 'main',
  status: 'active',
  activeWorkspaceCount: 1,
  activeSessionCount: 0,
  lastActivityAt: '2026-02-18T00:00:00.000Z',
};

function renderDashboard() {
  return render(
    <ToastProvider>
      <MemoryRouter>
        <Dashboard />
      </MemoryRouter>
    </ToastProvider>
  );
}

describe('Dashboard page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listProjects.mockReturnValue({ projects: [] });
  });

  it('shows projects section heading', () => {
    renderDashboard();
    expect(screen.getByRole('heading', { name: 'Projects' })).toBeInTheDocument();
  });

  it('shows welcome message with user name', () => {
    renderDashboard();
    expect(screen.getByText(/Welcome, Dev User/)).toBeInTheDocument();
  });

  it('shows Import Project button', () => {
    mocks.listProjects.mockReturnValue({ projects: [sampleProject] });
    renderDashboard();
    expect(screen.getByRole('button', { name: 'Import Project' })).toBeInTheDocument();
  });

  it('shows empty state when no projects', () => {
    renderDashboard();
    expect(screen.getByText('Import your first project')).toBeInTheDocument();
  });

  it('renders project cards when projects exist', () => {
    mocks.listProjects.mockReturnValue({ projects: [sampleProject] });
    renderDashboard();
    expect(screen.getByTestId('project-summary-card')).toBeInTheDocument();
    expect(screen.getByText('Project One')).toBeInTheDocument();
  });

  it('does not render workspace management controls', () => {
    renderDashboard();
    // Dashboard no longer shows workspace controls (removed in 022)
    expect(screen.queryByRole('button', { name: 'New Workspace' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Stop' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Restart' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument();
  });

  it('does not show unlinked workspaces section', () => {
    renderDashboard();
    expect(screen.queryByText('Unlinked Workspaces')).not.toBeInTheDocument();
  });
});
