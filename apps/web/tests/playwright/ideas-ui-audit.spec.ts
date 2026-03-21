import { test, expect, type Page, type Route } from '@playwright/test';

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

function makeDetailTask(overrides: TaskOverrides & { dependencies?: Array<{ id: string; title: string; status: string }> }) {
  return {
    ...makeTask(overrides),
    dependencies: overrides.dependencies ?? [],
  };
}

// Sample data sets
const NORMAL_TASKS = [
  makeTask({ id: 't1', title: 'Implement user authentication', status: 'draft', description: 'Add OAuth2 login flow with GitHub' }),
  makeTask({ id: 't2', title: 'Fix database migration', status: 'ready', description: 'Migration 015 fails on fresh install', priority: 5 }),
  makeTask({ id: 't3', title: 'Add dark mode toggle', status: 'in_progress', description: 'User preference for light/dark theme', startedAt: '2026-03-20T09:00:00Z' }),
  makeTask({ id: 't4', title: 'Refactor API error handling', status: 'completed', completedAt: '2026-03-19T15:00:00Z' }),
  makeTask({ id: 't5', title: 'Update dependencies', status: 'cancelled' }),
];

const LONG_TEXT_TASKS = [
  makeTask({
    id: 'lt1',
    title: 'This is an extremely long task title that should definitely be truncated on mobile screens because it contains way too many words and characters to fit in a single line without breaking the layout or causing horizontal scroll issues on smaller viewports',
    status: 'draft',
    description: 'This task has a very long description that goes into great detail about what needs to be done. It includes multiple sentences explaining the requirements, the technical approach, the expected outcomes, and various edge cases that need to be handled. The description should wrap properly on mobile without any overflow issues. Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris.',
  }),
  makeTask({
    id: 'lt2',
    title: 'A',
    status: 'ready',
    description: null,
  }),
  makeTask({
    id: 'lt3',
    title: 'Fix: handling of special characters like <script>alert("xss")</script> & "quotes" and 日本語テスト',
    status: 'in_progress',
    description: 'Test with unicode: 🚀🎉💻 and HTML entities: &amp; &lt; &gt; and very long URLs: https://example.com/very/long/path/that/should/not/break/layout/even/when/it/contains/many/segments',
  }),
];

const MANY_TASKS = Array.from({ length: 30 }, (_, i) => {
  const statuses = ['draft', 'ready', 'queued', 'delegated', 'in_progress', 'completed', 'failed', 'cancelled'];
  return makeTask({
    id: `many-${i}`,
    title: `Task ${i + 1}: ${['Implement feature', 'Fix bug', 'Refactor module', 'Add tests', 'Update docs'][i % 5]} #${i + 1}`,
    status: statuses[i % statuses.length],
    description: i % 3 === 0 ? `Description for task ${i + 1}` : null,
    priority: i % 4 === 0 ? 10 : i % 3 === 0 ? 5 : 0,
    blocked: i % 7 === 0,
  });
});

const ERROR_TASK = makeDetailTask({
  id: 'err-1',
  title: 'Failed deployment task',
  status: 'failed',
  description: 'Deploy the staging environment with new configuration',
  errorMessage: 'Error: ETIMEOUT: Connection to cloud provider timed out after 30000ms. The server at api.hetzner.cloud did not respond within the configured timeout. This may be caused by network issues, firewall rules, or the provider being temporarily unavailable. Please check your network connectivity and try again. If the problem persists, check the Hetzner status page at https://status.hetzner.com for any ongoing incidents.',
  priority: 10,
  blocked: true,
  startedAt: '2026-03-20T08:00:00Z',
});

const COMPLETED_TASK_WITH_OUTPUT = makeDetailTask({
  id: 'out-1',
  title: 'Implement notification system',
  status: 'completed',
  description: 'Add push notifications for task status changes, agent completions, and system alerts.',
  outputSummary: 'Successfully implemented the notification system with the following changes:\n\n1. Added NotificationCenter component with grouped notifications by project\n2. Implemented request_human_input MCP tool for agent-initiated notifications\n3. Added progress notification batching (5-minute window per task)\n4. Created notification preferences page in Settings\n5. Added session_ended notification on conversation completion\n\nAll tests passing. 94% code coverage achieved.',
  outputBranch: 'sam/notification-system-phase2',
  outputPrUrl: 'https://github.com/raphaeltm/simple-agent-manager/pull/450',
  completedAt: '2026-03-19T16:30:00Z',
  startedAt: '2026-03-19T10:00:00Z',
});

const MOCK_EVENTS = [
  { id: 'ev1', taskId: 'err-1', fromStatus: null, toStatus: 'draft', actorType: 'user', reason: 'Created', createdAt: '2026-03-20T07:00:00Z' },
  { id: 'ev2', taskId: 'err-1', fromStatus: 'draft', toStatus: 'ready', actorType: 'user', reason: null, createdAt: '2026-03-20T07:30:00Z' },
  { id: 'ev3', taskId: 'err-1', fromStatus: 'ready', toStatus: 'queued', actorType: 'system', reason: 'Auto-queued by task runner', createdAt: '2026-03-20T07:45:00Z' },
  { id: 'ev4', taskId: 'err-1', fromStatus: 'queued', toStatus: 'in_progress', actorType: 'system', reason: 'Workspace provisioned', createdAt: '2026-03-20T08:00:00Z' },
  { id: 'ev5', taskId: 'err-1', fromStatus: 'in_progress', toStatus: 'failed', actorType: 'system', reason: 'Connection timeout', createdAt: '2026-03-20T08:05:00Z' },
];

const MOCK_SESSIONS = [
  { id: 's1', taskId: 't1', topic: 'Auth implementation', status: 'stopped', messageCount: 42, startedAt: Date.now() - 3600000, endedAt: Date.now() - 1800000, createdAt: Date.now() - 3600000, workspaceId: 'ws-1' },
  { id: 's2', taskId: 't1', topic: 'Auth debugging', status: 'active', messageCount: 15, startedAt: Date.now() - 600000, endedAt: null, createdAt: Date.now() - 600000, workspaceId: 'ws-2' },
  { id: 's3', taskId: 't3', topic: 'Dark mode work', status: 'active', messageCount: 8, startedAt: Date.now() - 300000, endedAt: null, createdAt: Date.now() - 300000, workspaceId: 'ws-1' },
];

const MOCK_DASHBOARD_TASKS = [
  {
    id: 'dt1', projectId: 'proj-test-1', projectName: 'Test Project', title: 'Running deployment pipeline', status: 'in_progress',
    executionStep: 'running', isActive: true, sessionId: 's1', createdAt: '2026-03-20T10:00:00Z', lastMessageAt: Date.now() - 30000,
  },
  {
    id: 'dt2', projectId: 'proj-test-1', projectName: 'Test Project', title: 'Waiting for agent to start processing the request', status: 'queued',
    executionStep: 'provisioning_node', isActive: false, sessionId: null, createdAt: '2026-03-20T09:00:00Z', lastMessageAt: null,
  },
  {
    id: 'dt3', projectId: 'proj-test-1', projectName: 'Another Project With A Very Long Name That Should Truncate', title: 'This is a task with an extremely long title that needs to be properly truncated on mobile devices without breaking the card layout', status: 'in_progress',
    executionStep: 'running', isActive: true, sessionId: 's3', createdAt: '2026-03-20T08:00:00Z', lastMessageAt: Date.now() - 120000,
  },
];

const MOCK_PROJECTS = [
  { id: 'proj-test-1', name: 'Test Project', repository: 'testuser/test-repo', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-03-20T00:00:00Z', taskCounts: { active: 2, total: 15 }, lastActivityAt: '2026-03-20T10:00:00Z' },
  { id: 'proj-test-2', name: 'Another Project', repository: 'testuser/another-repo', createdAt: '2026-02-01T00:00:00Z', updatedAt: '2026-03-18T00:00:00Z', taskCounts: { active: 0, total: 5 }, lastActivityAt: '2026-03-18T15:00:00Z' },
];

// ---------------------------------------------------------------------------
// API Mock Setup
// ---------------------------------------------------------------------------

async function setupApiMocks(page: Page, options: {
  tasks?: ReturnType<typeof makeTask>[];
  sessions?: typeof MOCK_SESSIONS;
  dashboardTasks?: typeof MOCK_DASHBOARD_TASKS;
  taskDetail?: ReturnType<typeof makeDetailTask> | null;
  events?: typeof MOCK_EVENTS;
  projects?: typeof MOCK_PROJECTS;
  projectError?: boolean;
  tasksError?: boolean;
} = {}) {
  const {
    tasks = NORMAL_TASKS,
    sessions = MOCK_SESSIONS,
    dashboardTasks = [],
    taskDetail = null,
    events = [],
    projects = MOCK_PROJECTS,
    projectError = false,
    tasksError = false,
  } = options;

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
      return respond(200, []);
    }

    // Credentials
    if (path.startsWith('/api/credentials')) {
      return respond(200, { credentials: [] });
    }

    // Workspaces
    if (path.startsWith('/api/workspaces')) {
      return respond(200, []);
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

async function takeScreenshot(page: Page, name: string) {
  // Wait for any loading spinners to disappear
  await page.waitForTimeout(500);
  await page.screenshot({
    path: `../../.codex/tmp/playwright-screenshots/${name}.png`,
    fullPage: true,
  });
}

// ===========================================================================
// IDEAS PAGE TESTS
// ===========================================================================

test.describe('IdeasPage - Mobile Audit', () => {
  test('empty state', async ({ page }) => {
    await setupApiMocks(page, { tasks: [], sessions: [] });
    await page.goto('/projects/proj-test-1/ideas');
    await page.waitForSelector('text=Ideas');
    await takeScreenshot(page, 'ideas-empty-state');

    // Verify empty state message is visible
    await expect(page.getByText('Ideas emerge from your conversations')).toBeVisible();
  });

  test('normal data with mixed statuses', async ({ page }) => {
    await setupApiMocks(page, { tasks: NORMAL_TASKS, sessions: MOCK_SESSIONS });
    await page.goto('/projects/proj-test-1/ideas');
    await page.waitForSelector('text=Ideas');
    await page.waitForSelector('text=Implement user authentication');
    await takeScreenshot(page, 'ideas-normal-data');

    // Verify status groups are visible (use role to avoid matching <option> elements)
    await expect(page.getByRole('button', { name: /Exploring/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /Executing/i })).toBeVisible();
  });

  test('long text content', async ({ page }) => {
    await setupApiMocks(page, { tasks: LONG_TEXT_TASKS, sessions: [] });
    await page.goto('/projects/proj-test-1/ideas');
    await page.waitForSelector('text=Ideas');
    await page.waitForTimeout(500);
    await takeScreenshot(page, 'ideas-long-text');

    // Verify layout is not broken - check that search bar is still visible
    await expect(page.getByPlaceholder('Search ideas...')).toBeVisible();
  });

  test('many items (30 tasks)', async ({ page }) => {
    await setupApiMocks(page, { tasks: MANY_TASKS, sessions: [] });
    await page.goto('/projects/proj-test-1/ideas');
    await page.waitForSelector('text=Ideas');
    await page.waitForTimeout(500);
    await takeScreenshot(page, 'ideas-many-items');
  });

  test('search filter active', async ({ page }) => {
    await setupApiMocks(page, { tasks: NORMAL_TASKS, sessions: MOCK_SESSIONS });
    await page.goto('/projects/proj-test-1/ideas');
    await page.waitForSelector('text=Implement user authentication');

    await page.getByPlaceholder('Search ideas...').fill('database');
    await page.waitForTimeout(300);
    await takeScreenshot(page, 'ideas-search-filter');
  });

  test('search no results', async ({ page }) => {
    await setupApiMocks(page, { tasks: NORMAL_TASKS, sessions: MOCK_SESSIONS });
    await page.goto('/projects/proj-test-1/ideas');
    await page.waitForSelector('text=Implement user authentication');

    await page.getByPlaceholder('Search ideas...').fill('nonexistent query xyz');
    await page.waitForTimeout(300);
    await takeScreenshot(page, 'ideas-search-no-results');

    await expect(page.getByText('No ideas match your search.')).toBeVisible();
  });

  test('status filter active', async ({ page }) => {
    await setupApiMocks(page, { tasks: NORMAL_TASKS, sessions: MOCK_SESSIONS });
    await page.goto('/projects/proj-test-1/ideas');
    await page.waitForSelector('text=Implement user authentication');

    await page.getByLabel('Filter by status').selectOption('executing');
    await page.waitForTimeout(300);
    await takeScreenshot(page, 'ideas-status-filter');
  });

  test('collapsed groups expanded', async ({ page }) => {
    // Include completed and cancelled tasks (in done/parked which are collapsed by default)
    await setupApiMocks(page, { tasks: NORMAL_TASKS, sessions: MOCK_SESSIONS });
    await page.goto('/projects/proj-test-1/ideas');
    await page.waitForSelector('text=Implement user authentication');

    // Expand Done group
    const doneButton = page.getByRole('button', { name: /Done/i });
    if (await doneButton.isVisible()) {
      await doneButton.click();
    }
    // Expand Parked group
    const parkedButton = page.getByRole('button', { name: /Parked/i });
    if (await parkedButton.isVisible()) {
      await parkedButton.click();
    }

    await page.waitForTimeout(300);
    await takeScreenshot(page, 'ideas-all-groups-expanded');
  });

  test('API error state', async ({ page }) => {
    await setupApiMocks(page, { tasksError: true });
    await page.goto('/projects/proj-test-1/ideas');
    await page.waitForTimeout(1000);
    await takeScreenshot(page, 'ideas-api-error');
  });
});

// ===========================================================================
// TASK DETAIL PAGE TESTS
// ===========================================================================

test.describe('TaskDetail - Mobile Audit', () => {
  test('normal task detail', async ({ page }) => {
    const task = makeDetailTask({
      id: 'detail-1',
      title: 'Implement user authentication',
      status: 'in_progress',
      description: 'Add OAuth2 login flow with GitHub provider. Include session management and token refresh.',
      priority: 5,
      startedAt: '2026-03-20T09:00:00Z',
    });
    await setupApiMocks(page, { taskDetail: task, events: MOCK_EVENTS, tasks: NORMAL_TASKS });
    await page.goto('/projects/proj-test-1/ideas/detail-1');
    await page.waitForSelector('text=Implement user authentication');
    await takeScreenshot(page, 'task-detail-normal');
  });

  test('failed task with long error message', async ({ page }) => {
    await setupApiMocks(page, { taskDetail: ERROR_TASK, events: MOCK_EVENTS, tasks: NORMAL_TASKS });
    await page.goto('/projects/proj-test-1/ideas/err-1');
    await page.waitForSelector('text=Failed deployment task');
    await takeScreenshot(page, 'task-detail-error');

    // Verify error section is visible
    await expect(page.getByRole('heading', { name: 'Error' })).toBeVisible();
    await expect(page.getByText('ETIMEOUT')).toBeVisible();
  });

  test('completed task with output', async ({ page }) => {
    await setupApiMocks(page, { taskDetail: COMPLETED_TASK_WITH_OUTPUT, events: MOCK_EVENTS, tasks: NORMAL_TASKS });
    await page.goto('/projects/proj-test-1/ideas/out-1');
    await page.waitForSelector('text=Implement notification system');
    await takeScreenshot(page, 'task-detail-with-output');

    // Verify output section is visible
    await expect(page.getByText('Output')).toBeVisible();
    await expect(page.getByText('sam/notification-system-phase2')).toBeVisible();
  });

  test('task with long title', async ({ page }) => {
    const longTitleTask = makeDetailTask({
      id: 'long-title-1',
      title: 'This is an extremely long task title that should wrap properly on mobile without breaking the layout or causing overflow issues on the detail page view',
      status: 'draft',
      description: 'Short description.',
      priority: 0,
    });
    await setupApiMocks(page, { taskDetail: longTitleTask, events: [], tasks: NORMAL_TASKS });
    await page.goto('/projects/proj-test-1/ideas/long-title-1');
    await page.waitForSelector('text=This is an extremely long task title');
    await takeScreenshot(page, 'task-detail-long-title');
  });

  test('task with no description', async ({ page }) => {
    const noDescTask = makeDetailTask({
      id: 'no-desc-1',
      title: 'Task without description',
      status: 'ready',
      description: null,
    });
    await setupApiMocks(page, { taskDetail: noDescTask, events: [], tasks: NORMAL_TASKS });
    await page.goto('/projects/proj-test-1/ideas/no-desc-1');
    await page.waitForSelector('text=Task without description');
    await takeScreenshot(page, 'task-detail-no-description');

    await expect(page.getByText('No description.')).toBeVisible();
  });

  test('blocked task', async ({ page }) => {
    const blockedTask = makeDetailTask({
      id: 'blocked-1',
      title: 'Blocked task waiting on dependency',
      status: 'ready',
      description: 'This task is blocked by another task.',
      blocked: true,
      priority: 10,
    });
    await setupApiMocks(page, { taskDetail: blockedTask, events: [], tasks: NORMAL_TASKS });
    await page.goto('/projects/proj-test-1/ideas/blocked-1');
    await page.waitForSelector('text=Blocked task waiting on dependency');
    await takeScreenshot(page, 'task-detail-blocked');

    await expect(page.getByText('Blocked', { exact: true })).toBeVisible();
  });

  test('task with many activity events', async ({ page }) => {
    const manyEvents = Array.from({ length: 15 }, (_, i) => ({
      id: `ev-${i}`,
      taskId: 'detail-many-ev',
      fromStatus: i === 0 ? null : ['draft', 'ready', 'queued', 'in_progress'][i % 4],
      toStatus: ['draft', 'ready', 'queued', 'in_progress', 'failed'][i % 5],
      actorType: i % 2 === 0 ? 'user' : 'system',
      reason: i % 3 === 0 ? `Reason for transition ${i}` : null,
      createdAt: new Date(Date.now() - (15 - i) * 3600000).toISOString(),
    }));
    const task = makeDetailTask({
      id: 'detail-many-ev',
      title: 'Task with extensive activity',
      status: 'in_progress',
      description: 'This task has many status transitions.',
    });
    await setupApiMocks(page, { taskDetail: task, events: manyEvents, tasks: NORMAL_TASKS });
    await page.goto('/projects/proj-test-1/ideas/detail-many-ev');
    await page.waitForSelector('text=Task with extensive activity');
    await takeScreenshot(page, 'task-detail-many-events');
  });

  test('task with dependencies', async ({ page }) => {
    const task = makeDetailTask({
      id: 'detail-deps',
      title: 'Build notification UI',
      status: 'ready',
      description: 'Create the notification center component.',
      dependencies: [
        { id: 't-dep-1', title: 'Implement notification API endpoints', status: 'completed' },
        { id: 't-dep-2', title: 'Design notification data model and migration', status: 'in_progress' },
        { id: 't-dep-3', title: 'Set up WebSocket push channel for real-time delivery', status: 'draft' },
      ],
    });
    await setupApiMocks(page, { taskDetail: task, tasks: NORMAL_TASKS });
    await page.goto('/projects/proj-test-1/ideas/detail-deps');
    await page.waitForSelector('text=Build notification UI');
    await takeScreenshot(page, 'task-detail-with-dependencies');
  });
});

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
    await takeScreenshot(page, 'dashboard-active-tasks');
  });

  test('many active tasks', async ({ page }) => {
    const manyDashboardTasks = Array.from({ length: 8 }, (_, i) => ({
      id: `dt-many-${i}`,
      projectId: 'proj-test-1',
      projectName: i % 2 === 0 ? 'Test Project' : 'Another Project With Long Name',
      title: `Task ${i + 1}: ${['Running tests', 'Deploying', 'Building', 'Processing', 'Analyzing'][i % 5]}`,
      status: i % 2 === 0 ? 'in_progress' : 'queued',
      executionStep: i % 3 === 0 ? 'provisioning_node' : 'running',
      isActive: i % 2 === 0,
      sessionId: i % 2 === 0 ? `s-${i}` : null,
      createdAt: new Date(Date.now() - i * 3600000).toISOString(),
      lastMessageAt: i % 2 === 0 ? Date.now() - i * 60000 : null,
    }));
    await setupApiMocks(page, { dashboardTasks: manyDashboardTasks, projects: MOCK_PROJECTS });
    await page.goto('/dashboard');
    await page.waitForSelector('text=Active Tasks');
    await page.waitForTimeout(500);
    await takeScreenshot(page, 'dashboard-many-active-tasks');
  });

  test('dashboard with long project names and task titles', async ({ page }) => {
    const longNameTasks = [
      {
        id: 'dt-long-1',
        projectId: 'proj-test-1',
        projectName: 'This Is A Very Long Project Name That Should Be Truncated Properly On Mobile',
        title: 'Implementing a complex feature that requires multiple steps across several services and should be truncated in the card',
        status: 'in_progress',
        executionStep: 'running',
        isActive: true,
        sessionId: 's1',
        createdAt: '2026-03-20T10:00:00Z',
        lastMessageAt: Date.now() - 5000,
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

    // Type a long task description — the input may take time to render
    const input = page.getByPlaceholder('Describe the task for the agent...');
    try {
      await input.waitFor({ state: 'visible', timeout: 5000 });
      await input.fill('This is a very long task description that the user is typing to test how the input field handles long text on mobile screens without breaking or overflowing the layout');
      await page.waitForTimeout(300);
    } catch {
      // If input isn't visible, still take screenshot to document the state
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
