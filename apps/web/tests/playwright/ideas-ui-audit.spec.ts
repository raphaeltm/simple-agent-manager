import { expect, type Page, type Route, test } from '@playwright/test';

// ---------------------------------------------------------------------------
// Mock Data Factories
// ---------------------------------------------------------------------------

const MOCK_USER = {
  user: {
    id: 'user-test-1',
    email: 'test@example.com',
    name: 'Test User',
    image: null,
    role: 'superadmin',
    status: 'active',
    emailVerified: true,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  },
  session: {
    id: 'session-test-1',
    userId: 'user-test-1',
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
    token: 'mock-token',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  },
};

const MOCK_PROJECT = {
  id: 'proj-test-1',
  name: 'Test Project',
  repository: 'testuser/test-repo',
  defaultBranch: 'main',
  userId: 'user-test-1',
  githubInstallationId: 'inst-1',
  defaultVmSize: null,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

interface TaskOverrides {
  id: string;
  title: string;
  status?: string;
  description?: string | null;
  priority?: number;
  errorMessage?: string | null;
  outputSummary?: string | null;
  outputBranch?: string | null;
  outputPrUrl?: string | null;
  blocked?: boolean;
  startedAt?: string | null;
  completedAt?: string | null;
  createdAt?: string;
  updatedAt?: string;
  executionStep?: string | null;
  workspaceId?: string | null;
}

function makeTask(overrides: TaskOverrides) {
  return {
    projectId: 'proj-test-1',
    userId: 'user-test-1',
    parentTaskId: null,
    workspaceId: overrides.workspaceId ?? null,
    description: overrides.description ?? null,
    status: overrides.status ?? 'draft',
    executionStep: overrides.executionStep ?? null,
    priority: overrides.priority ?? 0,
    taskMode: 'task',
    dispatchDepth: 0,
    agentProfileHint: null,
    blocked: overrides.blocked ?? false,
    startedAt: overrides.startedAt ?? null,
    completedAt: overrides.completedAt ?? null,
    errorMessage: overrides.errorMessage ?? null,
    outputSummary: overrides.outputSummary ?? null,
    outputBranch: overrides.outputBranch ?? null,
    outputPrUrl: overrides.outputPrUrl ?? null,
    finalizedAt: null,
    createdAt: overrides.createdAt ?? '2026-03-20T10:00:00Z',
    updatedAt: overrides.updatedAt ?? '2026-03-20T10:00:00Z',
    ...overrides,
  };
}

function makeDetailTask(
  overrides: TaskOverrides & { dependencies?: Array<{ id: string; title: string; status: string }> }
) {
  return {
    ...makeTask(overrides),
    dependencies: overrides.dependencies ?? [],
  };
}

// Sample data sets
const NORMAL_TASKS = [
  makeTask({
    id: 't1',
    title: 'Implement user authentication',
    status: 'draft',
    description: 'Add OAuth2 login flow with GitHub',
  }),
  makeTask({
    id: 't2',
    title: 'Fix database migration',
    status: 'draft',
    description: 'Migration 015 fails on fresh install',
    priority: 5,
  }),
  makeTask({
    id: 't3',
    title: 'Add dark mode toggle',
    status: 'draft',
    description: 'User preference for light/dark theme',
    startedAt: '2026-03-20T09:00:00Z',
  }),
  makeTask({
    id: 't4',
    title: 'Refactor API error handling',
    status: 'draft',
    completedAt: '2026-03-19T15:00:00Z',
  }),
  makeTask({ id: 't5', title: 'Update dependencies', status: 'draft' }),
];

const MOCK_SESSIONS = [
  {
    id: 's1',
    taskId: 't1',
    topic: 'Auth implementation',
    status: 'stopped',
    messageCount: 42,
    startedAt: Date.now() - 3600000,
    endedAt: Date.now() - 1800000,
    createdAt: Date.now() - 3600000,
    workspaceId: 'ws-1',
  },
  {
    id: 's2',
    taskId: 't1',
    topic: 'Auth debugging',
    status: 'active',
    messageCount: 15,
    startedAt: Date.now() - 600000,
    endedAt: null,
    createdAt: Date.now() - 600000,
    workspaceId: 'ws-2',
  },
  {
    id: 's3',
    taskId: 't3',
    topic: 'Dark mode work',
    status: 'active',
    messageCount: 8,
    startedAt: Date.now() - 300000,
    endedAt: null,
    createdAt: Date.now() - 300000,
    workspaceId: 'ws-1',
  },
];

const MOCK_DASHBOARD_TASKS = [
  {
    id: 'dt1',
    projectId: 'proj-test-1',
    projectName: 'Test Project',
    title: 'Running deployment pipeline',
    status: 'in_progress',
    executionStep: 'running',
    isActive: true,
    agentActivityState: 'working',
    sessionId: 's1',
    createdAt: '2026-03-20T10:00:00Z',
    lastMessageAt: Date.now() - 30000,
    messageCount: 4,
  },
  {
    id: 'dt2',
    projectId: 'proj-test-1',
    projectName: 'Test Project',
    title: 'Sleeping conversation checkpoint',
    status: 'in_progress',
    executionStep: 'awaiting_followup',
    isActive: false,
    agentActivityState: 'sleeping',
    sessionId: null,
    createdAt: '2026-03-20T09:00:00Z',
    lastMessageAt: null,
    messageCount: 0,
  },
  {
    id: 'dt3',
    projectId: 'proj-test-1',
    projectName: 'Another Project With A Very Long Name That Should Truncate',
    title:
      'This is a task with an extremely long title that needs to be properly truncated on mobile devices without breaking the card layout',
    status: 'in_progress',
    executionStep: 'running',
    isActive: true,
    agentActivityState: 'working',
    sessionId: 's3',
    createdAt: '2026-03-20T08:00:00Z',
    lastMessageAt: Date.now() - 120000,
    messageCount: 9,
  },
];

const MOCK_PROJECTS = [
  {
    id: 'proj-test-1',
    name: 'Test Project',
    repository: 'testuser/test-repo',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-03-20T00:00:00Z',
    taskCounts: { active: 2, total: 15 },
    lastActivityAt: '2026-03-20T10:00:00Z',
  },
  {
    id: 'proj-test-2',
    name: 'Another Project',
    repository: 'testuser/another-repo',
    createdAt: '2026-02-01T00:00:00Z',
    updatedAt: '2026-03-18T00:00:00Z',
    taskCounts: { active: 0, total: 5 },
    lastActivityAt: '2026-03-18T15:00:00Z',
  },
];

// ---------------------------------------------------------------------------
// API Mock Setup
// ---------------------------------------------------------------------------

async function setupApiMocks(
  page: Page,
  options: {
    tasks?: ReturnType<typeof makeTask>[];
    sessions?: typeof MOCK_SESSIONS;
    dashboardTasks?: typeof MOCK_DASHBOARD_TASKS;
    taskDetail?: ReturnType<typeof makeDetailTask> | null;
    events?: Array<Record<string, unknown>>;
    projects?: typeof MOCK_PROJECTS;
    workspaces?: Array<Record<string, unknown>>;
    projectError?: boolean;
    tasksError?: boolean;
  } = {}
) {
  const {
    tasks = NORMAL_TASKS,
    sessions = MOCK_SESSIONS,
    dashboardTasks = [],
    taskDetail = null,
    events = [],
    projects = MOCK_PROJECTS,
    workspaces = [],
    projectError = false,
    tasksError = false,
  } = options;

  await page.addInitScript((userId) => {
    window.localStorage.setItem(`sam-onboarding-wizard-dismissed-${userId}`, 'true');
  }, MOCK_USER.user.id);

  // Single route handler for all API calls — uses URL path matching internally
  // to avoid Playwright's route priority ordering issues
  await page.route('**/api/**', async (route: Route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const method = route.request().method();
    const respond = (status: number, body: unknown) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

    // Auth
    if (path.includes('/api/auth/')) {
      return respond(200, MOCK_USER);
    }

    // Dashboard active tasks
    if (path === '/api/dashboard/active-tasks') {
      return respond(200, { tasks: dashboardTasks });
    }

    // GitHub installations
    if (path === '/api/github/installations') {
      return respond(200, []);
    }

    // Notifications
    if (path.startsWith('/api/notifications')) {
      return respond(200, { notifications: [], unreadCount: 0 });
    }

    // Agents
    if (path === '/api/agents') {
      return respond(200, { agents: [] });
    }

    // Credentials
    if (path === '/api/credentials/agent') return respond(200, { credentials: [] });
    if (path === '/api/credentials') return respond(200, []);

    // Workspaces
    if (path.startsWith('/api/workspaces')) {
      return respond(200, workspaces);
    }

    // Project-scoped routes
    const projectMatch = path.match(/^\/api\/projects\/([^/]+)(\/.*)?$/);
    if (projectMatch) {
      const subPath = projectMatch[2] || '';

      // Runtime config
      if (subPath === '/runtime-config') {
        return respond(200, { envVars: [], files: [] });
      }

      // Sessions
      if (subPath.startsWith('/sessions')) {
        return respond(200, { sessions, total: sessions.length });
      }

      // Task events
      if (subPath.match(/^\/tasks\/[^/]+\/events$/)) {
        return respond(200, { events });
      }

      // Task detail (single task by ID)
      if (subPath.match(/^\/tasks\/[^/]+$/)) {
        if (taskDetail) {
          return respond(200, taskDetail);
        }
        return respond(404, { error: 'Not found' });
      }

      // List tasks
      if (subPath === '/tasks' || subPath.startsWith('/tasks?')) {
        if (method === 'GET') {
          if (tasksError) {
            return respond(500, { error: 'Failed to load tasks' });
          }
          return respond(200, { tasks, nextCursor: null });
        }
        return respond(200, {});
      }

      // Project detail (no sub-path, or just the project ID)
      if (!subPath || subPath === '/') {
        if (projectError) {
          return respond(500, { error: 'Internal server error' });
        }
        return respond(200, MOCK_PROJECT);
      }
    }

    // Projects list
    if (path === '/api/projects') {
      if (method === 'GET') {
        return respond(200, { projects });
      }
      return respond(200, {});
    }

    // Health
    if (path.endsWith('/health')) {
      return respond(200, { status: 'ok' });
    }

    // Catch-all
    console.log(`Unhandled API route: ${method} ${path}`);
    return respond(200, {});
  });
}

async function assertNoOverflow(page: Page) {
  const overflow = await page.evaluate(() => ({
    docOverflow: document.documentElement.scrollWidth > window.innerWidth,
    bodyOverflow: document.body.scrollWidth > window.innerWidth,
    docWidth: document.documentElement.scrollWidth,
    bodyWidth: document.body.scrollWidth,
    viewportWidth: window.innerWidth,
  }));
  expect(
    overflow.docOverflow,
    `Document scrollWidth (${overflow.docWidth}) exceeds viewport (${overflow.viewportWidth})`
  ).toBe(false);
  expect(
    overflow.bodyOverflow,
    `Body scrollWidth (${overflow.bodyWidth}) exceeds viewport (${overflow.viewportWidth})`
  ).toBe(false);
}

async function takeScreenshot(page: Page, name: string) {
  // Wait for any loading spinners to disappear
  await page.waitForTimeout(500);
  const viewport = page.viewportSize();
  const suffix = viewport ? `-${viewport.width}x${viewport.height}` : '';
  await page.screenshot({
    path: `../../.codex/tmp/playwright-screenshots/${name}${suffix}.png`,
    fullPage: true,
  });
}

// ===========================================================================
// IDEAS PAGE TESTS
// ===========================================================================

// ===========================================================================
// The Ideas list has its own audit: `ideas-list-audit.spec.ts`. This file keeps the
// dashboard's active task cards and the task submit form, which share these mocks.
// ===========================================================================

// ===========================================================================
// DASHBOARD / ACTIVE TASK CARDS TESTS
// ===========================================================================

test.describe('Dashboard ActiveTaskCards - Mobile Audit', () => {
  test('empty active tasks', async ({ page }) => {
    await setupApiMocks(page, { dashboardTasks: [], projects: MOCK_PROJECTS });
    await page.goto('/dashboard');
    await page.waitForSelector('text=Active Tasks');
    await takeScreenshot(page, 'dashboard-empty-tasks');

    await expect(page.getByText('No active tasks')).toBeVisible();
  });

  test('active tasks with normal data', async ({ page }) => {
    await setupApiMocks(page, { dashboardTasks: MOCK_DASHBOARD_TASKS, projects: MOCK_PROJECTS });
    await page.goto('/dashboard');
    await page.waitForSelector('text=Active Tasks');
    await page.waitForSelector('text=Running deployment pipeline');
    await expect(page.getByText('Sleeping', { exact: true })).toBeVisible();
    await assertNoOverflow(page);
    await takeScreenshot(page, 'dashboard-active-tasks');
  });

  test('many active tasks', async ({ page }) => {
    const manyDashboardTasks = Array.from({ length: 8 }, (_, i) => ({
      id: `dt-many-${i}`,
      projectId: 'proj-test-1',
      projectName: i % 2 === 0 ? 'Test Project' : 'Another Project With Long Name',
      title: `Task ${i + 1}: ${['Running tests', 'Deploying', 'Building', 'Processing', 'Analyzing'][i % 5]}`,
      status: i % 2 === 0 ? 'in_progress' : 'queued',
      executionStep: i % 3 === 0 ? 'awaiting_followup' : 'running',
      isActive: i % 2 === 0,
      agentActivityState: i % 3 === 0 ? 'sleeping' : i % 2 === 0 ? 'working' : 'awake-idle',
      sessionId: i % 2 === 0 ? `s-${i}` : null,
      createdAt: new Date(Date.now() - i * 3600000).toISOString(),
      lastMessageAt: i % 2 === 0 ? Date.now() - i * 60000 : null,
      messageCount: i % 2 === 0 ? i + 1 : 0,
    }));
    await setupApiMocks(page, { dashboardTasks: manyDashboardTasks, projects: MOCK_PROJECTS });
    await page.goto('/dashboard');
    await page.waitForSelector('text=Active Tasks');
    await page.waitForTimeout(500);
    await expect(page.getByText('Sleeping', { exact: true })).toHaveCount(3);
    await assertNoOverflow(page);
    await takeScreenshot(page, 'dashboard-many-active-tasks');
  });

  test('dashboard with long project names and task titles', async ({ page }) => {
    const longNameTasks = [
      {
        id: 'dt-long-1',
        projectId: 'proj-test-1',
        projectName: 'This Is A Very Long Project Name That Should Be Truncated Properly On Mobile',
        title:
          'Implementing a complex feature that requires multiple steps across several services and should be truncated in the card',
        status: 'in_progress',
        executionStep: 'running',
        isActive: true,
        agentActivityState: 'working',
        sessionId: 's1',
        createdAt: '2026-03-20T10:00:00Z',
        lastMessageAt: Date.now() - 5000,
        messageCount: 13,
      },
    ];
    await setupApiMocks(page, { dashboardTasks: longNameTasks, projects: MOCK_PROJECTS });
    await page.goto('/dashboard');
    await page.waitForSelector('text=Active Tasks');
    await page.waitForTimeout(500);
    await takeScreenshot(page, 'dashboard-long-names');
  });
});

// ===========================================================================
// TASK SUBMIT FORM TESTS (in ProjectChat context)
// ===========================================================================

test.describe('TaskSubmitForm - Mobile Audit', () => {
  test('default state', async ({ page }) => {
    await setupApiMocks(page, { tasks: [], sessions: [] });
    await page.goto('/projects/proj-test-1/chat');
    // Wait for chat page to load
    await page.waitForTimeout(1000);
    await takeScreenshot(page, 'chat-task-submit-default');
  });

  test('with advanced options expanded', async ({ page }) => {
    await setupApiMocks(page, { tasks: [], sessions: [] });
    await page.goto('/projects/proj-test-1/chat');
    await page.waitForTimeout(1000);

    // Click "Show advanced options"
    const advancedToggle = page.getByText('Show advanced options');
    if (await advancedToggle.isVisible()) {
      await advancedToggle.click();
      await page.waitForTimeout(300);
    }
    await takeScreenshot(page, 'chat-task-submit-advanced');
  });

  test('with long input text', async ({ page }) => {
    await setupApiMocks(page, { tasks: [], sessions: [] });
    await page.goto('/projects/proj-test-1/chat');
    await page.waitForTimeout(1500);

    // Type a long task description
    const input = page.getByPlaceholder('Describe what you want the agent to do...');
    if (await input.isVisible()) {
      await input.fill(
        'This is a very long task description that the user is typing to test how the input field handles long text on mobile screens without breaking or overflowing the layout'
      );
      await page.waitForTimeout(300);
    }
    await takeScreenshot(page, 'chat-task-submit-long-input');
  });

  test('project error state', async ({ page }) => {
    await setupApiMocks(page, { projectError: true, tasks: [], sessions: [] });
    await page.goto('/projects/proj-test-1/chat');
    await page.waitForTimeout(1500);
    await takeScreenshot(page, 'chat-project-error');
  });
});

// ===========================================================================
// TOUCH TARGET BOUNDING BOX ASSERTIONS
// ===========================================================================

test('Connector provenance on the active task cards', async ({ page }) => {
  const connectorClientName = 'Claude Research 🧪 & planning '.repeat(9);
  const dashboardTasks = MOCK_DASHBOARD_TASKS.map((task) => ({
    ...task,
    triggeredBy: 'connector',
    connectorClientName,
  }));
  await setupApiMocks(page, { dashboardTasks });
  await page.goto('/dashboard');
  await expect(page.getByTitle(`Created via ${connectorClientName}`).first()).toBeVisible();
  await assertNoOverflow(page);
  await takeScreenshot(page, 'connector-dashboard-provenance');
});
