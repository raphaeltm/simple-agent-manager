import type { ProjectDetailResponse } from '@simple-agent-manager/shared';
import { act, screen, waitFor } from '@testing-library/react';
import { useEffect } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { Project } from '../../src/pages/Project';
import { useProjectContext } from '../../src/pages/ProjectContext';
import { renderWithQuery } from '../test-utils/query-test-utils';

// Mock AuthProvider
vi.mock('../../src/components/AuthProvider', () => ({
  useAuth: () => ({
    user: { id: 'user-1', name: 'Test User', email: 'test@example.com', image: null },
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

const mockGetProject = vi.fn();
const mockListGitHubInstallations = vi.fn();

// Mock API calls
vi.mock('../../src/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/api')>()),
  getProject: (...args: unknown[]) => mockGetProject(...args),
  listGitHubInstallations: (...args: unknown[]) => mockListGitHubInstallations(...args),
}));

const defaultProject = {
  id: 'proj-1',
  name: 'My Project',
  description: 'A test project',
  repository: 'owner/repo',
  defaultBranch: 'main',
  repoProvider: 'github',
  installationId: 'inst-1',
  status: 'active',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  userId: 'user-1',
  summary: {
    repoProvider: 'github',
    activeWorkspaceCount: 2,
    activeSessionCount: 3,
    lastActivityAt: '2026-01-15T12:00:00Z',
    taskCountsByStatus: { ready: 1, in_progress: 2 },
    linkedWorkspaces: 2,
  },
} satisfies ProjectDetailResponse;

function renderProject(path = '/projects/proj-1/overview') {
  return renderWithQuery(
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
  mockGetProject.mockReset();
  mockListGitHubInstallations.mockReset();
  mockGetProject.mockResolvedValue(defaultProject);
  mockListGitHubInstallations.mockResolvedValue([]);
});

describe('Project shell (non-chat routes)', () => {
  it('does not render a desktop header bar (project name is in the sidebar)', async () => {
    renderProject();
    await screen.findByTestId('overview-content');
    // No PageLayout header — project name is communicated to sidebar via AppShell context
    expect(screen.queryByRole('heading', { name: 'My Project' })).not.toBeInTheDocument();
    await waitFor(() => {
      expect(mockSetProjectName).toHaveBeenCalledWith('My Project');
    });
  });

  it('renders child route content via Outlet', async () => {
    renderProject('/projects/proj-1/overview');
    expect(await screen.findByTestId('overview-content')).toBeInTheDocument();
  });

  it('renders one truthful initial error without also claiming the project was not found', async () => {
    mockGetProject.mockRejectedValueOnce(new Error('Project service unavailable'));
    renderProject('/projects/proj-1/overview');

    expect(await screen.findByRole('alert')).toHaveTextContent('Project service unavailable');
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    expect(screen.queryByText('Project not found.')).not.toBeInTheDocument();
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

describe('Project reload (stale-while-revalidate)', () => {
  it('reload() does NOT unmount child content — children stay visible while refetching', async () => {
    // Regression: before the stale-while-revalidate fix, every
    // loadProject() call set projectLoading=true which swapped the Outlet
    // tree for a spinner, unmounting all child state and re-running mount
    // effects.

    let resolveReload: (v: typeof defaultProject) => void;

    const unmountSpy = vi.fn();

    // Child component that calls reload() and tracks mount/unmount
    function ReloadChildWithUnmountTracking() {
      const { reload } = useProjectContext();
      useEffect(() => {
        return () => { unmountSpy(); };
      }, []);
      return (
        <div>
          <div data-testid="child-content">I am mounted</div>
          <button data-testid="reload-btn" onClick={() => void reload()}>Reload</button>
        </div>
      );
    }

    // Initial load resolves immediately
    mockGetProject.mockResolvedValueOnce(defaultProject);

    const { findByTestId, getByTestId } = renderWithQuery(
      <MemoryRouter initialEntries={['/projects/proj-1/overview']}>
        <Routes>
          <Route path="/projects/:id" element={<Project />}>
            <Route path="overview" element={<ReloadChildWithUnmountTracking />} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );

    // Wait for initial load
    await findByTestId('child-content');
    expect(getByTestId('child-content')).toHaveTextContent('I am mounted');
    unmountSpy.mockClear();

    // Set up a deferred reload response so we can assert the child
    // stays mounted while the reload is in flight
    mockGetProject.mockImplementationOnce(
      () => new Promise((resolve) => { resolveReload = resolve; })
    );

    // Trigger reload
    await act(async () => {
      getByTestId('reload-btn').click();
    });

    // Child must still be visible — NOT replaced by a spinner
    expect(getByTestId('child-content')).toBeInTheDocument();
    expect(getByTestId('child-content')).toHaveTextContent('I am mounted');
    // Child must NOT have been unmounted
    expect(unmountSpy).not.toHaveBeenCalled();

    // Resolve the reload
    await act(async () => {
      resolveReload!({ ...defaultProject, name: 'Updated Project' });
    });

    // Child is still mounted after reload completes
    expect(getByTestId('child-content')).toBeInTheDocument();
    expect(unmountSpy).not.toHaveBeenCalled();
  });

  it('keeps child content mounted and does not replace it with an alert when reload fails', async () => {
    function ReloadChild() {
      const { reload } = useProjectContext();
      return (
        <div>
          <div data-testid="stale-child-content">Cached project content</div>
          <button data-testid="failed-reload-btn" onClick={() => void reload()}>Reload</button>
        </div>
      );
    }

    const { findByTestId, getByTestId, queryByRole } = renderWithQuery(
      <MemoryRouter initialEntries={['/projects/proj-1/overview']}>
        <Routes>
          <Route path="/projects/:id" element={<Project />}>
            <Route path="overview" element={<ReloadChild />} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );

    await findByTestId('stale-child-content');
    mockGetProject.mockRejectedValueOnce(new Error('Background reload failed'));
    await act(async () => {
      getByTestId('failed-reload-btn').click();
    });

    await waitFor(() => expect(mockGetProject).toHaveBeenCalledTimes(2));
    expect(getByTestId('stale-child-content')).toHaveTextContent('Cached project content');
    expect(queryByRole('alert')).not.toBeInTheDocument();
  });
});
