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

vi.mock('../../src/pages/AdminInfrastructure', () => ({
  AdminInfrastructure: () => <div data-testid="admin-infrastructure-page" />,
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

vi.mock('../../src/pages/AdminProjectEvents', () => ({
  AdminProjectEvents: () => <div data-testid="admin-project-events-page" />,
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

vi.mock('../../src/pages/SettingsInfrastructure', () => ({
  SettingsInfrastructure: () => <div data-testid="settings-infrastructure-page" />,
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

vi.mock('../../src/pages/Sam', () => ({
  Sam: () => <div data-testid="sam-page" />,
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

vi.mock('../../src/pages/ProjectContext', () => ({
  useProjectContext: () => ({
    projectId: 'proj-1',
    project: null,
    installations: [],
    reload: async () => undefined,
  }),
}));

/** Automation page stand-ins that print where they landed and the params they received. */
async function automationStandIn(testId: string) {
  const { useLocation, useParams } = await import('react-router');
  return function StandIn() {
    const location = useLocation();
    const params = useParams();
    return (
      <div data-testid={testId}>
        {location.pathname + location.search} {JSON.stringify(params)}
      </div>
    );
  };
}

vi.mock('../../src/pages/automation/AutomationOverview', async () => ({
  AutomationOverview: await automationStandIn('automation-overview-page'),
}));
vi.mock('../../src/pages/automation/AutomationEditor', async () => ({
  AutomationEditor: await automationStandIn('automation-editor-page'),
}));
vi.mock('../../src/pages/automation/AutomationDetail', async () => ({
  AutomationDetail: await automationStandIn('automation-detail-page'),
}));
vi.mock('../../src/pages/automation/AutomationHistory', async () => ({
  AutomationHistory: await automationStandIn('automation-history-page'),
}));
vi.mock('../../src/pages/automation/AutomationBehind', async () => ({
  AutomationBehind: await automationStandIn('automation-behind-page'),
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
  // Pages other than Landing/Dashboard are code-split (`lazyNamed` in src/App.tsx), so
  // they resolve on a microtask rather than synchronously — hence `findByTestId`.
  it('routes /projects to the Projects page', async () => {
    renderAt('/projects');

    expect(await screen.findByTestId('projects-page')).toBeInTheDocument();
    expect(screen.queryByTestId('dashboard-page')).not.toBeInTheDocument();
  });

  describe('Automation', () => {
    it('routes every Automation view, with the automation id apart from the project id', async () => {
      renderAt('/projects/proj-1/automation/new');
      const editor = await screen.findByTestId('automation-editor-page');
      expect(editor).toHaveTextContent('/projects/proj-1/automation/new');
      expect(editor).not.toHaveTextContent('automationId');

      cleanup();
      renderAt('/projects/proj-1/automation/trigger/t1');
      expect(await screen.findByTestId('automation-detail-page')).toHaveTextContent(
        '"kind":"trigger","automationId":"t1"'
      );

      cleanup();
      renderAt('/projects/proj-1/automation/watch/w1/edit');
      expect(await screen.findByTestId('automation-editor-page')).toHaveTextContent(
        '"kind":"watch","automationId":"w1"'
      );

      cleanup();
      renderAt('/projects/proj-1/automation/history');
      expect(await screen.findByTestId('automation-history-page')).toBeInTheDocument();
    });

    it.each([
      ['/projects/proj-1/events', 'automation-overview-page', '/projects/proj-1/automation'],
      [
        '/projects/proj-1/events?section=channels',
        'automation-behind-page',
        '/automation/behind?tab=channels',
      ],
      [
        '/projects/proj-1/events?sessionId=s1',
        'automation-behind-page',
        '/automation/behind?sessionId=s1',
      ],
      ['/projects/proj-1/triggers', 'automation-overview-page', '/projects/proj-1/automation'],
      ['/projects/proj-1/triggers?edit=new', 'automation-editor-page', '/automation/new'],
      [
        '/projects/proj-1/triggers?edit=t1',
        'automation-editor-page',
        '/automation/trigger/t1/edit',
      ],
      ['/projects/proj-1/triggers/t1', 'automation-detail-page', '/automation/trigger/t1'],
    ])('sends the old URL %s to the view that replaced it', async (from, testId, to) => {
      renderAt(from);
      expect(await screen.findByTestId(testId)).toHaveTextContent(to);
    });
  });

  it('routes /tools to the Tools page', async () => {
    renderAt('/tools');
    expect(await screen.findByTestId('tools-page')).toBeInTheDocument();
  });

  it('routes /tools/cli to the CLI download page', async () => {
    renderAt('/tools/cli');
    expect(await screen.findByTestId('tools-cli-page')).toBeInTheDocument();
  });

  it('routes /projects/:id/tasks/:taskId to the task redirect (redirects to chat session)', async () => {
    renderAt('/projects/proj-1/tasks/task-1');

    // TaskRedirect is a child route of Project that redirects to the chat session.
    // Both the shell and the child are code-split, so both are awaited.
    expect(await screen.findByTestId('project-detail-page')).toBeInTheDocument();
    expect(await screen.findByTestId('task-redirect-page')).toBeInTheDocument();
  });

  it('routes the account SAM assistant in production', async () => {
    vi.stubEnv('DEV', false);
    vi.stubEnv('PROD', true);
    vi.stubEnv('MODE', 'production');
    renderAt('/sam');
    expect(await screen.findByTestId('sam-page')).toBeInTheDocument();
  });

  it('keeps test harness routes available in local/test mode', async () => {
    renderAt('/__test/trial-chat-gate');
    expect(await screen.findByTestId('trial-chat-gate-harness-page')).toBeInTheDocument();

    cleanup();
    renderAt('/ui-standards');
    expect(await screen.findByTestId('ui-standards-page')).toBeInTheDocument();
  });

  it('redirects non-superadmins away from deep-linked admin child routes before child pages render', () => {
    mockUseAuth.mockReturnValue({ isSuperadmin: false });

    renderAt('/admin/users');

    // Still synchronous: the guard runs before the lazy Admin shell is ever requested,
    // and Dashboard is one of the two statically-imported pages.
    expect(screen.getByTestId('dashboard-page')).toBeInTheDocument();
    expect(screen.queryByTestId('admin-layout')).not.toBeInTheDocument();
    expect(screen.queryByTestId('admin-users-page')).not.toBeInTheDocument();
  });

  it('renders admin child routes for superadmins', async () => {
    mockUseAuth.mockReturnValue({ isSuperadmin: true });

    renderAt('/admin/users');

    expect(await screen.findByTestId('admin-layout')).toBeInTheDocument();
    expect(await screen.findByTestId('admin-users-page')).toBeInTheDocument();
  });

  it('routes the internal admin project eventing inspector for superadmins', async () => {
    mockUseAuth.mockReturnValue({ isSuperadmin: true });

    renderAt('/admin/project-events');

    expect(await screen.findByTestId('admin-layout')).toBeInTheDocument();
    expect(await screen.findByTestId('admin-project-events-page')).toBeInTheDocument();
  });

  it('routes admin Infrastructure for superadmins', async () => {
    mockUseAuth.mockReturnValue({ isSuperadmin: true });

    renderAt('/admin/infrastructure');

    expect(await screen.findByTestId('admin-layout')).toBeInTheDocument();
    expect(await screen.findByTestId('admin-infrastructure-page')).toBeInTheDocument();
  });

  it('routes user settings Infrastructure', async () => {
    renderAt('/settings/infrastructure');

    expect(await screen.findByTestId('settings-page')).toBeInTheDocument();
  });

  it('does not render inventoried dev-only routes under production env flags', () => {
    vi.stubEnv('DEV', false);
    vi.stubEnv('PROD', true);
    vi.stubEnv('MODE', 'production');

    expect(DEV_ONLY_ROUTE_PATHS).toEqual([
      '/prototype/accounts',
      '/__test/trial-chat-gate',
      '/__test/error-boundary',
      '/ui-standards',
    ]);
    expect(devOnlyRoutesEnabled()).toBe(false);

    for (const routePath of DEV_ONLY_ROUTE_PATHS) {
      cleanup();
      renderAt(routePath);

      expect(screen.getByTestId('landing-page')).toBeInTheDocument();
      expect(screen.queryByTestId('sam-page')).not.toBeInTheDocument();
      expect(screen.queryByTestId('trial-chat-gate-harness-page')).not.toBeInTheDocument();
      expect(screen.queryByTestId('ui-standards-page')).not.toBeInTheDocument();
    }
  });
});
