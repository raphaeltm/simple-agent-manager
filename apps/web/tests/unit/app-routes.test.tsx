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

vi.mock('../../src/components/AppShell', () => ({
  AppShell: ({ children }: { children: React.ReactNode }) => <div data-testid="app-shell">{children}</div>,
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

// Project now uses Outlet to render child routes, so mock it to pass children through
vi.mock('../../src/pages/Project', async () => {
  const { Outlet } = await import('react-router-dom');
  return {
    Project: () => <div data-testid="project-detail-page"><Outlet /></div>,
  };
});

vi.mock('../../src/pages/ProjectOverview', () => ({
  ProjectOverview: () => <div data-testid="project-overview-page" />,
}));

vi.mock('../../src/pages/ProjectTasks', () => ({
  ProjectTasks: () => <div data-testid="project-tasks-page" />,
}));

vi.mock('../../src/pages/ProjectSessions', () => ({
  ProjectSessions: () => <div data-testid="project-sessions-page" />,
}));

vi.mock('../../src/pages/ProjectSettings', () => ({
  ProjectSettings: () => <div data-testid="project-settings-page" />,
}));

vi.mock('../../src/pages/ProjectActivity', () => ({
  ProjectActivity: () => <div data-testid="project-activity-page" />,
}));

vi.mock('../../src/pages/TaskDetail', () => ({
  TaskDetail: () => <div data-testid="task-detail-page" />,
}));

vi.mock('../../src/pages/ChatSessionView', () => ({
  ChatSessionView: () => <div data-testid="chat-session-page" />,
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

  it('routes /projects/:id/tasks/:taskId to the task detail page nested inside project', () => {
    renderAt('/projects/proj-1/tasks/task-1');

    // TaskDetail is now a child route of Project, so both should be present
    expect(screen.getByTestId('project-detail-page')).toBeInTheDocument();
    expect(screen.getByTestId('task-detail-page')).toBeInTheDocument();
  });
});
