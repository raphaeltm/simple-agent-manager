import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mockUseAuth = vi.fn(() => ({ isSuperadmin: false }));

vi.mock('../../src/components/AuthProvider', () => ({
  AuthProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useAuth: () => mockUseAuth(),
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

vi.mock('../../src/pages/Landing', () => ({
  Landing: () => <div data-testid="landing-page" />,
}));

vi.mock('../../src/pages/Dashboard', () => ({
  Dashboard: () => <div data-testid="dashboard-page" />,
}));

vi.mock('../../src/pages/Admin', async () => {
  const { Outlet } = await import('react-router');
  return {
    Admin: () => (
      <div data-testid="admin-layout">
        <Outlet />
      </div>
    ),
  };
});

vi.mock('../../src/pages/AdminUsers', () => ({
  AdminUsers: () => <div data-testid="admin-users-page" />,
}));

vi.mock('../../src/pages/AdminPlatformConfig', () => ({
  AdminPlatformConfig: () => <div data-testid="admin-integrations-page" />,
}));

vi.mock('../../src/pages/AdminPlatformCredentials', () => ({
  AdminPlatformCredentials: () => <div data-testid="admin-credentials-page" />,
}));

vi.mock('../../src/pages/AdminAIProxy', () => ({
  AdminAIProxy: () => <div data-testid="admin-ai-proxy-page" />,
}));

vi.mock('../../src/pages/AdminTrials', () => ({
  AdminTrials: () => <div data-testid="admin-trials-page" />,
}));

vi.mock('../../src/pages/AdminCosts', () => ({
  AdminCosts: () => <div data-testid="admin-costs-page" />,
}));

vi.mock('../../src/pages/AdminComputeUsage', () => ({
  AdminComputeUsage: () => <div data-testid="admin-usage-page" />,
}));

vi.mock('../../src/pages/AdminComputeQuotas', () => ({
  AdminComputeQuotas: () => <div data-testid="admin-quotas-page" />,
}));

vi.mock('../../src/pages/AdminErrors', () => ({
  AdminErrors: () => <div data-testid="admin-errors-page" />,
}));

vi.mock('../../src/pages/AdminOverview', () => ({
  AdminOverview: () => <div data-testid="admin-overview-page" />,
}));

vi.mock('../../src/pages/AdminLogs', () => ({
  AdminLogs: () => <div data-testid="admin-logs-page" />,
}));

vi.mock('../../src/pages/AdminStream', () => ({
  AdminStream: () => <div data-testid="admin-stream-page" />,
}));

vi.mock('../../src/pages/AdminAnalytics', () => ({
  AdminAnalytics: () => <div data-testid="admin-analytics-page" />,
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

vi.mock('../../src/pages/SamPrototype', () => ({
  SamPrototype: () => <div data-testid="sam-prototype-page" />,
}));

vi.mock('../../src/pages/TrialChatGateHarness', () => ({
  TrialChatGateHarness: () => <div data-testid="trial-chat-gate-harness-page" />,
}));

vi.mock('../../src/pages/Projects', () => ({
  Projects: () => <div data-testid="projects-page" />,
}));

// Project now uses Outlet to render child routes, so mock it to pass children through
vi.mock('../../src/pages/Project', async () => {
  const { Outlet } = await import('react-router');
  return {
    Project: () => (
      <div data-testid="project-detail-page">
        <Outlet />
      </div>
    ),
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

import App, { DEV_ONLY_ROUTE_PATHS, devOnlyRoutesEnabled } from '../../src/App';

function renderAt(path: string) {
  window.history.pushState({}, '', path);
  return render(<App />);
}

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  mockUseAuth.mockReturnValue({ isSuperadmin: false });
});

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

  it('keeps prototype and test harness routes available in local/test mode', () => {
    renderAt('/sam');
    expect(screen.getByTestId('sam-prototype-page')).toBeInTheDocument();

    cleanup();
    renderAt('/__test/trial-chat-gate');
    expect(screen.getByTestId('trial-chat-gate-harness-page')).toBeInTheDocument();

    cleanup();
    renderAt('/ui-standards');
    expect(screen.getByTestId('ui-standards-page')).toBeInTheDocument();
  });

  it('redirects non-superadmins away from deep-linked admin child routes before child pages render', () => {
    mockUseAuth.mockReturnValue({ isSuperadmin: false });

    renderAt('/admin/users');

    expect(screen.getByTestId('dashboard-page')).toBeInTheDocument();
    expect(screen.queryByTestId('admin-layout')).not.toBeInTheDocument();
    expect(screen.queryByTestId('admin-users-page')).not.toBeInTheDocument();
  });

  it('renders admin child routes for superadmins', () => {
    mockUseAuth.mockReturnValue({ isSuperadmin: true });

    renderAt('/admin/users');

    expect(screen.getByTestId('admin-layout')).toBeInTheDocument();
    expect(screen.getByTestId('admin-users-page')).toBeInTheDocument();
  });

  it('does not render inventoried dev-only routes under production env flags', () => {
    vi.stubEnv('DEV', false);
    vi.stubEnv('PROD', true);
    vi.stubEnv('MODE', 'production');

    expect(DEV_ONLY_ROUTE_PATHS).toEqual(['/sam', '/__test/trial-chat-gate', '/ui-standards']);
    expect(devOnlyRoutesEnabled()).toBe(false);

    for (const routePath of DEV_ONLY_ROUTE_PATHS) {
      cleanup();
      renderAt(routePath);

      expect(screen.getByTestId('landing-page')).toBeInTheDocument();
      expect(screen.queryByTestId('sam-prototype-page')).not.toBeInTheDocument();
      expect(screen.queryByTestId('trial-chat-gate-harness-page')).not.toBeInTheDocument();
      expect(screen.queryByTestId('ui-standards-page')).not.toBeInTheDocument();
    }
  });
});
