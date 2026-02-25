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

// Mock SettingsDrawer
vi.mock('../../src/components/project/SettingsDrawer', () => ({
  SettingsDrawer: () => null,
}));

function renderProject(path = '/projects/proj-1/chat') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/projects/:id" element={<Project />}>
          <Route path="chat" element={<div data-testid="chat-content">Chat</div>} />
          <Route path="chat/:sessionId" element={<div data-testid="chat-session">Session</div>} />
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
  });

  it('renders repository link', async () => {
    renderProject();
    await screen.findByRole('heading', { name: 'My Project' });
    expect(screen.getByText('owner/repo')).toBeInTheDocument();
  });

  it('does not render tab navigation (chat-first layout)', async () => {
    renderProject();
    await screen.findByRole('heading', { name: 'My Project' });
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
    expect(screen.queryByRole('tab')).not.toBeInTheDocument();
  });

  it('renders child route content via Outlet', async () => {
    renderProject('/projects/proj-1/chat');
    expect(await screen.findByTestId('chat-content')).toBeInTheDocument();
  });

  it('renders settings gear button', async () => {
    renderProject();
    await screen.findByRole('heading', { name: 'My Project' });
    expect(screen.getByRole('button', { name: 'Project settings' })).toBeInTheDocument();
  });
});
