import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('../../src/components/AuthProvider', () => ({
  AuthProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
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

vi.mock('../../src/pages/Landing', () => ({
  Landing: () => <div data-testid="landing-page" />,
}));

vi.mock('../../src/pages/Dashboard', () => ({
  Dashboard: () => <div data-testid="dashboard-page" />,
}));

vi.mock('../../src/pages/Settings', () => ({
  Settings: () => <div data-testid="settings-page" />,
}));

vi.mock('../../src/pages/CreateWorkspace', () => ({
  CreateWorkspace: () => <div data-testid="create-workspace-page" />,
}));

vi.mock('../../src/pages/Workspace', () => ({
  Workspace: () => <div data-testid="workspace-page" />,
}));

vi.mock('../../src/pages/Nodes', () => ({
  Nodes: () => <div data-testid="nodes-page" />,
}));

vi.mock('../../src/pages/Node', () => ({
  Node: () => <div data-testid="node-page" />,
}));

vi.mock('../../src/pages/UiStandards', () => ({
  UiStandards: () => <div data-testid="ui-standards-page" />,
}));

vi.mock('../../src/pages/Projects', () => ({
  Projects: () => <div data-testid="projects-page" />,
}));

vi.mock('../../src/pages/Project', () => ({
  Project: () => <div data-testid="project-detail-page" />,
}));

vi.mock('../../src/pages/TaskDetail', () => ({
  TaskDetail: () => <div data-testid="task-detail-page" />,
}));

import App from '../../src/App';

function renderAt(path: string) {
  window.history.pushState({}, '', path);
  return render(<App />);
}

describe('App routes', () => {
  it('routes /projects to the Projects page', () => {
    renderAt('/projects');

    expect(screen.getByTestId('projects-page')).toBeInTheDocument();
    expect(screen.queryByTestId('dashboard-page')).not.toBeInTheDocument();
  });

  it('routes /projects/:id/tasks/:taskId to the task detail page', () => {
    renderAt('/projects/proj-1/tasks/task-1');

    expect(screen.getByTestId('task-detail-page')).toBeInTheDocument();
    expect(screen.queryByTestId('project-detail-page')).not.toBeInTheDocument();
  });
});
