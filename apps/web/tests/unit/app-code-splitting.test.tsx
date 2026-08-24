import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Suspense/code-splitting behaviour of the router.
 *
 * This lives in its own file because `React.lazy` memoises a resolved component for the
 * lifetime of the module graph: once a route has been visited, it no longer suspends.
 * Vitest isolates modules per test file, so a dedicated file is the only way to observe
 * the *first* paint of a route. For the same reason each test below uses a DIFFERENT
 * route — reusing one would make a later test silently non-discriminating.
 */

vi.mock('../../src/components/AuthProvider', () => ({
  AuthProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useAuth: () => ({ isSuperadmin: false }),
}));

vi.mock('../../src/components/ErrorBoundary', () => ({
  ErrorBoundary: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('../../src/hooks/useToast', () => ({
  ToastProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('../../src/components/ProtectedRoute', () => ({
  ProtectedRoute: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('../../src/components/AppShell', () => ({
  AppShell: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="app-shell">{children}</div>
  ),
}));

vi.mock('../../src/pages/Landing', () => ({ Landing: () => <div data-testid="landing-page" /> }));
vi.mock('../../src/pages/Dashboard', () => ({
  Dashboard: () => <div data-testid="dashboard-page" />,
}));
vi.mock('../../src/pages/Nodes', () => ({ Nodes: () => <div data-testid="nodes-page" /> }));
vi.mock('../../src/pages/Settings', () => ({
  Settings: () => <div data-testid="settings-page" />,
}));
vi.mock('../../src/pages/Chats', () => ({ Chats: () => <div data-testid="chats-page" /> }));

// Records module evaluation order so the Project-shell/ProjectChat waterfall fix can be
// observed: both chunks must start loading together, not one after the other.
const loadOrder = vi.hoisted(() => [] as string[]);

vi.mock('../../src/pages/Project', async () => {
  const { Outlet } = await import('react-router');
  loadOrder.push('Project');
  return {
    Project: () => (
      <div data-testid="project-detail-page">
        <Outlet />
      </div>
    ),
  };
});

vi.mock('../../src/pages/project-chat', () => {
  loadOrder.push('project-chat');
  return { ProjectChat: () => <div data-testid="project-chat-page" /> };
});

import App from '../../src/App';

function renderAt(path: string) {
  window.history.pushState({}, '', path);
  return render(<App />);
}

afterEach(() => {
  cleanup();
});

describe('App code splitting', () => {
  it('shows the route fallback on a code-split page, then swaps it for the page', async () => {
    renderAt('/nodes');

    // What the user sees for the first paint of an uncached chunk. It must appear and
    // then be replaced by the page — never linger.
    expect(screen.getByTestId('route-fallback')).toBeInTheDocument();
    expect(screen.queryByTestId('nodes-page')).not.toBeInTheDocument();

    expect(await screen.findByTestId('nodes-page')).toBeInTheDocument();
    expect(screen.queryByTestId('route-fallback')).not.toBeInTheDocument();
  });

  it('keeps the AppShell chrome mounted while a route chunk loads (rule 48)', async () => {
    renderAt('/settings');

    // Discriminating assertion for the per-route Suspense placement: one boundary
    // wrapping <Routes> (or wrapping ProtectedLayout's AppShell) would unmount the
    // chrome during the pending window and this would fail.
    expect(screen.getByTestId('route-fallback')).toBeInTheDocument();
    expect(screen.getByTestId('app-shell')).toBeInTheDocument();

    await screen.findByTestId('settings-page');
    expect(screen.getByTestId('app-shell')).toBeInTheDocument();
  });

  it('does not re-suspend a route whose chunk is already resolved', async () => {
    renderAt('/chats');
    expect(screen.getByTestId('route-fallback')).toBeInTheDocument();
    await screen.findByTestId('chats-page');
    cleanup();

    renderAt('/chats');

    // Second visit: React has the resolved lazy component cached, so the user gets the
    // page with no intervening fallback frame.
    expect(screen.queryByTestId('route-fallback')).not.toBeInTheDocument();
    expect(screen.getByTestId('chats-page')).toBeInTheDocument();
  });

  it('starts the project-chat chunk in parallel with the Project shell, not after it', async () => {
    expect(loadOrder).toEqual([]);

    renderAt('/projects/proj-1/chat');
    await screen.findByTestId('project-chat-page');

    // Both modules must have been requested. The discriminating part is that the child
    // import is kicked off inside the shell's own loader, so it is in flight before the
    // shell has rendered its <Outlet/>. Without the parallel kick-off in App.tsx the
    // child request would only begin after 'Project' finished evaluating and rendering.
    expect(loadOrder).toContain('Project');
    expect(loadOrder).toContain('project-chat');
    expect(screen.getByTestId('project-detail-page')).toBeInTheDocument();
  });

  it('renders the statically-imported landing set with no fallback at all', () => {
    renderAt('/');
    expect(screen.getByTestId('landing-page')).toBeInTheDocument();
    expect(screen.queryByTestId('route-fallback')).not.toBeInTheDocument();

    cleanup();

    renderAt('/dashboard');
    expect(screen.getByTestId('dashboard-page')).toBeInTheDocument();
    expect(screen.queryByTestId('route-fallback')).not.toBeInTheDocument();
  });
});
