import { render } from '@testing-library/react';
import { vi } from 'vitest';

// Shared router doubles. Vitest isolates this module per test file, preserving
// each suite's first-import gate and React.lazy cache.
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
const preloadState = vi.hoisted(() => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { order: [] as string[], gate, release };
});
export const preload = preloadState;
export const loadOrder = preloadState.order;

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

// Import App inside the module whose mock registrations Vitest hoists first.
import App from '../../src/App';

export function renderAt(path: string) {
  window.history.pushState({}, '', path);
  return render(<App />);
}
