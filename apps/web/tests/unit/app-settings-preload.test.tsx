import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

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
const preload = vi.hoisted(() => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { order: [] as string[], gate, release };
});
const loadOrder = preload.order;

vi.mock('../../src/pages/Project', async () => {
  const { Outlet } = await import('react-router');
  loadOrder.push('Project');
  await preload.gate;
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

vi.mock('../../src/pages/ProjectSettings', async () => {
  const { Outlet } = await import('react-router');
  loadOrder.push('settings');
  return {
    ProjectSettings: () => <Outlet />,
    ProjectSettingsRuntime: () => <div data-testid="runtime-tab" />,
  };
});

import App from '../../src/App';

function renderAt(path: string) {
  window.history.pushState({}, '', path);
  return render(<App />);
}

afterEach(() => {
  cleanup();
});

it('warms settings alongside a pending project shell without fetching the chat chunk', async () => {
  renderAt('/projects/project-1/settings/runtime');
  await waitFor(() => {
    expect(loadOrder).toContain('Project');
    expect(loadOrder).toContain('settings');
  });
  expect(loadOrder).not.toContain('project-chat');
  expect(screen.queryByTestId('runtime-tab')).not.toBeInTheDocument();
  await act(async () => preload.release());
  expect(await screen.findByTestId('runtime-tab')).toBeInTheDocument();
  expect(loadOrder).not.toContain('project-chat');
});
