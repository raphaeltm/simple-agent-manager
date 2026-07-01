import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

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

vi.mock('../../src/pages/Tools', () => ({
  Tools: () => <div data-testid="tools-page" />,
}));

vi.mock('../../src/pages/ToolsCli', () => ({
  ToolsCli: () => <div data-testid="tools-cli-page" />,
}));

vi.mock('../../src/pages/UiStandards', () => ({
  UiStandards: () => <div data-testid="ui-standards-page" />,
}));

vi.mock('../../src/pages/Projects', () => ({
  Projects: () => <div data-testid="projects-page" />,
}));

// Project now uses Outlet to render child routes, so mock it to pass children through
vi.mock('../../src/pages/Project', async () => {
  const { Outlet } = await import('react-router');
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
  ProjectSettingsAccess: () => <div data-testid="project-settings-access-page" />,
  ProjectSettingsAgents: () => <div data-testid="project-settings-agents-page" />,
  ProjectSettingsConnections: () => <div data-testid="project-settings-connections-page" />,
  ProjectSettingsDeploy: () => <div data-testid="project-settings-deploy-page" />,
  ProjectSettingsGeneral: () => <div data-testid="project-settings-general-page" />,
  ProjectSettingsIndexRedirect: () => <div data-testid="project-settings-index-redirect" />,
  ProjectSettingsInfrastructure: () => <div data-testid="project-settings-infrastructure-page" />,
  ProjectSettingsRuntime: () => <div data-testid="project-settings-runtime-page" />,
}));

vi.mock('../../src/pages/ProjectActivity', () => ({
  ProjectActivity: () => <div data-testid="project-activity-page" />,
}));

vi.mock('../../src/pages/TaskRedirect', () => ({
  TaskRedirect: () => <div data-testid="task-redirect-page" />,
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

  it('routes /tools to the Tools page', () => {
    renderAt('/tools');
    expect(screen.getByTestId('tools-page')).toBeInTheDocument();
  });

  it('routes /tools/cli to the CLI download page', () => {
    renderAt('/tools/cli');
    expect(screen.getByTestId('tools-cli-page')).toBeInTheDocument();
  });

  it('routes /projects/:id/tasks/:taskId to the task redirect (redirects to chat session)', () => {
    renderAt('/projects/proj-1/tasks/task-1');

    // TaskRedirect is a child route of Project that redirects to the chat session
    expect(screen.getByTestId('project-detail-page')).toBeInTheDocument();
    expect(screen.getByTestId('task-redirect-page')).toBeInTheDocument();
  });
});
