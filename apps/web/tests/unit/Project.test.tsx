import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route,Routes } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { Project } from '../../src/pages/Project';

// Mock AuthProvider
vi.mock('../../src/components/AuthProvider', () => ({
  useAuth: () => ({
    user: { name: 'Test User', email: 'test@example.com', image: null },
  }),
}));

// Mock AppShell context
const mockSetProjectName = vi.fn();
vi.mock('../../src/components/AppShell', () => ({
  useAppShell: () => ({ setProjectName: mockSetProjectName }),
}));

// Mock auth lib
vi.mock('../../src/lib/auth', () => ({
  signOut: vi.fn(),
}));

// Mock API calls
vi.mock('../../src/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/api')>()),
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

function renderProject(path = '/projects/proj-1/overview') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/projects/:id" element={<Project />}>
          <Route path="overview" element={<div data-testid="overview-content">Overview</div>} />
          <Route path="chat" element={<div data-testid="chat-content">Chat</div>} />
          <Route path="chat/:sessionId" element={<div data-testid="chat-session">Session</div>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  mockSetProjectName.mockClear();
});

describe('Project shell (non-chat routes)', () => {
  it('does not render a desktop header bar (project name is in the sidebar)', async () => {
    renderProject();
    await screen.findByTestId('overview-content');
    // No PageLayout header — project name is communicated to sidebar via AppShell context
    expect(screen.queryByRole('heading', { name: 'My Project' })).not.toBeInTheDocument();
    expect(mockSetProjectName).toHaveBeenCalledWith('My Project');
  });

  it('renders child route content via Outlet', async () => {
    renderProject('/projects/proj-1/overview');
    expect(await screen.findByTestId('overview-content')).toBeInTheDocument();
  });
});

describe('Project shell (chat route — full-bleed)', () => {
  it('renders child route content via Outlet without PageLayout', async () => {
    renderProject('/projects/proj-1/chat');
    expect(await screen.findByTestId('chat-content')).toBeInTheDocument();
    // Chat routes bypass PageLayout — no heading, breadcrumb, or repo link
    expect(screen.queryByRole('heading', { name: 'My Project' })).not.toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Breadcrumb' })).not.toBeInTheDocument();
  });

  it('renders session route content without PageLayout', async () => {
    renderProject('/projects/proj-1/chat/session-1');
    expect(await screen.findByTestId('chat-session')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'My Project' })).not.toBeInTheDocument();
  });
});
