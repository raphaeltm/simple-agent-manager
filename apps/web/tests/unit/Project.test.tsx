import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { describe, it, expect, vi } from 'vitest';
import { Project } from '../../src/pages/Project';

// Mock AuthProvider
vi.mock('../../src/components/AuthProvider', () => ({
  useAuth: () => ({
    user: { name: 'Test User', email: 'test@example.com', image: null },
  }),
}));

// Mock auth lib
vi.mock('../../src/lib/auth', () => ({
  signOut: vi.fn(),
}));

// Mock API calls
vi.mock('../../src/lib/api', () => ({
  getProject: vi.fn().mockResolvedValue({
    id: 'proj-1',
    name: 'My Project',
    description: 'A test project',
    repository: 'owner/repo',
    defaultBranch: 'main',
    installationId: 'inst-1',
    status: 'active',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    userId: 'user-1',
    summary: {
      activeWorkspaceCount: 2,
      activeSessionCount: 3,
      lastActivityAt: '2026-01-15T12:00:00Z',
      taskCountsByStatus: { ready: 1, in_progress: 2 },
      linkedWorkspaces: 2,
    },
  }),
  listGitHubInstallations: vi.fn().mockResolvedValue([]),
}));

function renderProject(path = '/projects/proj-1/overview') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/projects/:id" element={<Project />}>
          <Route path="overview" element={<div data-testid="overview-content">Overview</div>} />
          <Route path="tasks" element={<div data-testid="tasks-content">Tasks</div>} />
          <Route path="sessions" element={<div data-testid="sessions-content">Sessions</div>} />
          <Route path="settings" element={<div data-testid="settings-content">Settings</div>} />
          <Route path="activity" element={<div data-testid="activity-content">Activity</div>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

describe('Project shell', () => {
  it('renders project name as heading after loading', async () => {
    renderProject();
    expect(await screen.findByRole('heading', { name: 'My Project' })).toBeInTheDocument();
  });

  it('renders breadcrumb navigation', async () => {
    renderProject();
    await screen.findByRole('heading', { name: 'My Project' });
    expect(screen.getByRole('navigation', { name: 'Breadcrumb' })).toBeInTheDocument();
    expect(screen.getByText('Dashboard')).toBeInTheDocument();
    expect(screen.getByText('Projects')).toBeInTheDocument();
  });

  it('renders repository and branch info', async () => {
    renderProject();
    await screen.findByRole('heading', { name: 'My Project' });
    expect(screen.getByText('owner/repo@main')).toBeInTheDocument();
  });

  it('renders tab navigation with 5 tabs', async () => {
    renderProject();
    await screen.findByRole('heading', { name: 'My Project' });
    const tablist = screen.getByRole('tablist');
    expect(tablist).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Overview' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Tasks' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Sessions' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Settings' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Activity' })).toBeInTheDocument();
  });

  it('renders child route content via Outlet', async () => {
    renderProject('/projects/proj-1/overview');
    expect(await screen.findByTestId('overview-content')).toBeInTheDocument();
  });

  it('marks the active tab based on current route', async () => {
    renderProject('/projects/proj-1/tasks');
    await screen.findByRole('heading', { name: 'My Project' });
    const tasksTab = screen.getByRole('tab', { name: 'Tasks' });
    expect(tasksTab).toHaveAttribute('aria-selected', 'true');
  });

  it('renders description when present', async () => {
    renderProject();
    expect(await screen.findByText('A test project')).toBeInTheDocument();
  });
});
