import { expect, type Page, type Route, test } from '@playwright/test';

// ---------------------------------------------------------------------------
// Mock Data
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

interface TriggerOverrides {
  id: string;
  name: string;
  status?: string;
  description?: string | null;
  cronExpression?: string;
  cronHumanReadable?: string;
  cronTimezone?: string;
  nextFireAt?: string | null;
  lastTriggeredAt?: string | null;
  triggerCount?: number;
}

function makeTrigger(overrides: TriggerOverrides) {
  return {
    projectId: 'proj-test-1',
    userId: 'user-test-1',
    sourceType: 'cron',
    skipIfRunning: true,
    promptTemplate: 'Review open PRs for {{project.name}}',
    agentProfileId: null,
    taskMode: 'task',
    vmSizeOverride: null,
    maxConcurrent: 1,
    triggerCount: overrides.triggerCount ?? 0,
    createdAt: '2026-03-01T00:00:00Z',
    updatedAt: '2026-03-01T00:00:00Z',
    cronExpression: overrides.cronExpression ?? '0 9 * * *',
    cronHumanReadable: overrides.cronHumanReadable ?? 'Daily at 9:00 AM',
    cronTimezone: overrides.cronTimezone ?? 'UTC',
    nextFireAt: overrides.nextFireAt ?? new Date(Date.now() + 3600000).toISOString(),
    lastTriggeredAt: overrides.lastTriggeredAt ?? null,
    description: overrides.description ?? null,
    status: overrides.status ?? 'active',
    ...overrides,
  };
}

interface ExecutionOverrides {
  id: string;
  status?: string;
  scheduledAt?: string;
  startedAt?: string | null;
  completedAt?: string | null;
  errorMessage?: string | null;
  skipReason?: string | null;
  taskId?: string | null;
}

function makeExecution(overrides: ExecutionOverrides) {
  return {
    triggerId: 'trig-1',
    projectId: 'proj-test-1',
    eventType: 'cron',
    renderedPrompt: 'Review open PRs for Test Project',
    sequenceNumber: 1,
    createdAt: '2026-03-20T09:00:00Z',
    scheduledAt: overrides.scheduledAt ?? '2026-03-20T09:00:00Z',
    startedAt: overrides.startedAt ?? '2026-03-20T09:00:05Z',
    completedAt: overrides.completedAt ?? '2026-03-20T09:05:00Z',
    errorMessage: overrides.errorMessage ?? null,
    skipReason: overrides.skipReason ?? null,
    taskId: overrides.taskId ?? 'task-1',
    status: overrides.status ?? 'completed',
    ...overrides,
  };
}

// Sample datasets
const NORMAL_TRIGGERS = [
  makeTrigger({
    id: 'trig-1',
    name: 'Daily Code Review',
    description: 'Reviews all open pull requests every morning',
    status: 'active',
    lastTriggeredAt: new Date(Date.now() - 3600000).toISOString(),
    triggerCount: 42,
  }),
  makeTrigger({
    id: 'trig-2',
    name: 'Weekly Report',
    description: 'Generates a weekly project summary',
    status: 'active',
    cronExpression: '0 10 * * 1',
    cronHumanReadable: 'Every Monday at 10:00 AM',
    triggerCount: 8,
  }),
  makeTrigger({
    id: 'trig-3',
    name: 'Nightly Tests',
    status: 'paused',
    description: 'Run full test suite every night',
    cronExpression: '0 2 * * *',
    cronHumanReadable: 'Daily at 2:00 AM',
    triggerCount: 15,
  }),
];

const LONG_TEXT_TRIGGERS = [
  makeTrigger({
    id: 'lt-1',
    name: 'This is an extremely long trigger name that should definitely be truncated on mobile screens because it contains way too many words and characters to fit in a single line without breaking the layout',
    description: 'This trigger has a very long description that goes into great detail about what the trigger does, when it fires, what kind of tasks it creates, and why it was configured this way. It includes multiple sentences with technical details.',
    status: 'active',
    cronHumanReadable: 'Every 4 hours at minute 0 during weekdays in America/New_York timezone',
  }),
  makeTrigger({
    id: 'lt-2',
    name: 'A',
    description: null,
    status: 'disabled',
  }),
  makeTrigger({
    id: 'lt-3',
    name: 'Special chars: <script>alert("xss")</script> & "quotes" and 日本語テスト',
    description: 'Unicode: 🚀🎉💻 and HTML: &amp; &lt; &gt; and URL: https://example.com/very/long/path/that/should/not/break/layout',
    status: 'paused',
  }),
];

const MANY_TRIGGERS = Array.from({ length: 10 }, (_, i) => {
  const statuses = ['active', 'paused', 'disabled'];
  return makeTrigger({
    id: `many-${i}`,
    name: `Trigger ${i + 1}: ${['Code Review', 'Test Suite', 'Report Gen', 'Cleanup', 'Deploy Check'][i % 5]}`,
    status: statuses[i % statuses.length],
    description: i % 2 === 0 ? `Description for trigger ${i + 1}` : null,
    triggerCount: i * 10,
  });
});

const NORMAL_EXECUTIONS = [
  makeExecution({ id: 'ex-1', status: 'completed', taskId: 'task-1' }),
  makeExecution({
    id: 'ex-2',
    status: 'failed',
    scheduledAt: '2026-03-19T09:00:00Z',
    startedAt: '2026-03-19T09:00:05Z',
    completedAt: '2026-03-19T09:01:00Z',
    errorMessage: 'Workspace provisioning failed: ETIMEOUT',
    taskId: 'task-2',
  }),
  makeExecution({
    id: 'ex-3',
    status: 'skipped',
    scheduledAt: '2026-03-18T09:00:00Z',
    startedAt: null,
    completedAt: null,
    skipReason: 'still_running',
    taskId: null,
  }),
  makeExecution({
    id: 'ex-4',
    status: 'running',
    scheduledAt: '2026-03-20T09:00:00Z',
    startedAt: '2026-03-20T09:00:05Z',
    completedAt: null,
    taskId: 'task-4',
  }),
];

// ---------------------------------------------------------------------------
// API Mock Setup
// ---------------------------------------------------------------------------

async function setupApiMocks(page: Page, options: {
  triggers?: ReturnType<typeof makeTrigger>[];
  triggerDetail?: ReturnType<typeof makeTrigger> | null;
  executions?: ReturnType<typeof makeExecution>[];
  triggersError?: boolean;
} = {}) {
  const {
    triggers = NORMAL_TRIGGERS,
    triggerDetail = null,
    executions = NORMAL_EXECUTIONS,
    triggersError = false,
  } = options;

  await page.route('**/api/**', async (route: Route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const respond = (status: number, body: unknown) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

    // Auth
    if (path.includes('/api/auth/')) {
      return respond(200, MOCK_USER);
    }

    // Dashboard active tasks
    if (path === '/api/dashboard/active-tasks') {
      return respond(200, { tasks: [] });
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
        return respond(200, { sessions: [], total: 0 });
      }

      // Tasks
      if (subPath.startsWith('/tasks')) {
        return respond(200, { tasks: [], total: 0 });
      }

      // Trigger executions
      if (subPath.match(/^\/triggers\/[^/]+\/executions/)) {
        return respond(200, { executions, nextCursor: null });
      }

      // Trigger detail
      if (subPath.match(/^\/triggers\/[^/]+$/) && !subPath.endsWith('/triggers')) {
        if (triggerDetail) return respond(200, triggerDetail);
        const triggerId = subPath.split('/').pop();
        const found = triggers.find((t) => t.id === triggerId);
        return respond(found ? 200 : 404, found ?? { error: 'not_found' });
      }

      // Triggers list
      if (subPath === '/triggers') {
        if (triggersError) return respond(500, { error: 'INTERNAL_ERROR', message: 'Server error' });
        return respond(200, { triggers });
      }

      // Project detail
      return respond(200, MOCK_PROJECT);
    }

    // Projects list
    if (path === '/api/projects') {
      return respond(200, [MOCK_PROJECT]);
    }

    return route.continue();
  });
}

// ---------------------------------------------------------------------------
// Screenshot helper
// ---------------------------------------------------------------------------

async function screenshot(page: Page, name: string) {
  await page.waitForTimeout(600);
  await page.screenshot({
    path: `../../.codex/tmp/playwright-screenshots/${name}.png`,
    fullPage: true,
  });
}

async function assertNoOverflow(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth
  );
  expect(overflow).toBe(false);
}

// ---------------------------------------------------------------------------
// Tests: Triggers List — Mobile
// ---------------------------------------------------------------------------

test.describe('Triggers List — Mobile', () => {
  test.use({ viewport: { width: 375, height: 667 }, isMobile: true });

  test('normal data', async ({ page }) => {
    await setupApiMocks(page, { triggers: NORMAL_TRIGGERS });
    await page.goto('/projects/proj-test-1/triggers');
    await page.waitForSelector('text=Daily Code Review');
    await screenshot(page, 'triggers-list-normal-mobile');
    await assertNoOverflow(page);
  });

  test('long text wraps correctly', async ({ page }) => {
    await setupApiMocks(page, { triggers: LONG_TEXT_TRIGGERS });
    await page.goto('/projects/proj-test-1/triggers');
    await page.waitForSelector('text=Special chars');
    await screenshot(page, 'triggers-list-long-text-mobile');
    await assertNoOverflow(page);
  });

  test('empty state', async ({ page }) => {
    await setupApiMocks(page, { triggers: [] });
    await page.goto('/projects/proj-test-1/triggers');
    await page.waitForSelector('text=No triggers yet');
    await screenshot(page, 'triggers-list-empty-mobile');
    await assertNoOverflow(page);
  });

  test('many items', async ({ page }) => {
    await setupApiMocks(page, { triggers: MANY_TRIGGERS });
    await page.goto('/projects/proj-test-1/triggers');
    await page.waitForSelector('text=Trigger 1');
    await screenshot(page, 'triggers-list-many-mobile');
    await assertNoOverflow(page);
  });

  test('error state', async ({ page }) => {
    await setupApiMocks(page, { triggersError: true });
    await page.goto('/projects/proj-test-1/triggers');
    await page.waitForSelector('text=Retry');
    await screenshot(page, 'triggers-list-error-mobile');
    await assertNoOverflow(page);
  });
});

// ---------------------------------------------------------------------------
// Tests: Triggers List — Desktop
// ---------------------------------------------------------------------------

test.describe('Triggers List — Desktop', () => {
  test.use({ viewport: { width: 1280, height: 800 }, isMobile: false });

  test('normal data', async ({ page }) => {
    await setupApiMocks(page, { triggers: NORMAL_TRIGGERS });
    await page.goto('/projects/proj-test-1/triggers');
    await page.waitForSelector('text=Daily Code Review');
    await screenshot(page, 'triggers-list-normal-desktop');
    await assertNoOverflow(page);
  });

  test('long text', async ({ page }) => {
    await setupApiMocks(page, { triggers: LONG_TEXT_TRIGGERS });
    await page.goto('/projects/proj-test-1/triggers');
    await page.waitForSelector('text=Special chars');
    await screenshot(page, 'triggers-list-long-text-desktop');
    await assertNoOverflow(page);
  });

  test('empty state', async ({ page }) => {
    await setupApiMocks(page, { triggers: [] });
    await page.goto('/projects/proj-test-1/triggers');
    await page.waitForSelector('text=No triggers yet');
    await screenshot(page, 'triggers-list-empty-desktop');
    await assertNoOverflow(page);
  });
});

// ---------------------------------------------------------------------------
// Tests: Trigger Detail — Mobile
// ---------------------------------------------------------------------------

test.describe('Trigger Detail — Mobile', () => {
  test.use({ viewport: { width: 375, height: 667 }, isMobile: true });

  test('normal data with executions', async ({ page }) => {
    await setupApiMocks(page, {
      triggers: NORMAL_TRIGGERS,
      triggerDetail: NORMAL_TRIGGERS[0],
      executions: NORMAL_EXECUTIONS,
    });
    await page.goto('/projects/proj-test-1/triggers/trig-1');
    await page.waitForSelector('text=Daily Code Review');
    await screenshot(page, 'trigger-detail-normal-mobile');
    await assertNoOverflow(page);
  });

  test('no executions', async ({ page }) => {
    await setupApiMocks(page, {
      triggers: NORMAL_TRIGGERS,
      triggerDetail: NORMAL_TRIGGERS[1],
      executions: [],
    });
    await page.goto('/projects/proj-test-1/triggers/trig-2');
    await page.waitForSelector('text=Weekly Report');
    await screenshot(page, 'trigger-detail-empty-mobile');
    await assertNoOverflow(page);
  });
});

// ---------------------------------------------------------------------------
// Tests: Trigger Detail — Desktop
// ---------------------------------------------------------------------------

test.describe('Trigger Detail — Desktop', () => {
  test.use({ viewport: { width: 1280, height: 800 }, isMobile: false });

  test('normal data with execution history', async ({ page }) => {
    await setupApiMocks(page, {
      triggers: NORMAL_TRIGGERS,
      triggerDetail: NORMAL_TRIGGERS[0],
      executions: NORMAL_EXECUTIONS,
    });
    await page.goto('/projects/proj-test-1/triggers/trig-1');
    await page.waitForSelector('text=Daily Code Review');
    await screenshot(page, 'trigger-detail-normal-desktop');
    await assertNoOverflow(page);
  });
});

// ---------------------------------------------------------------------------
// Tests: Trigger Creation Form — Mobile
// ---------------------------------------------------------------------------

test.describe('Trigger Form — Mobile', () => {
  test.use({ viewport: { width: 375, height: 667 }, isMobile: true });

  test('new trigger form renders', async ({ page }) => {
    await setupApiMocks(page, { triggers: [] });
    await page.goto('/projects/proj-test-1/triggers');
    await page.waitForSelector('text=No triggers yet');
    await page.click('text=Create your first trigger');
    await page.waitForSelector('text=New Trigger');
    await screenshot(page, 'trigger-form-new-mobile');
    await assertNoOverflow(page);
  });
});

// ---------------------------------------------------------------------------
// Tests: Trigger Creation Form — Desktop
// ---------------------------------------------------------------------------

test.describe('Trigger Form — Desktop', () => {
  test.use({ viewport: { width: 1280, height: 800 }, isMobile: false });

  test('new trigger form with all schedule tabs', async ({ page }) => {
    await setupApiMocks(page, { triggers: NORMAL_TRIGGERS });
    await page.goto('/projects/proj-test-1/triggers');
    await page.waitForSelector('text=Daily Code Review');
    await page.click('text=New Trigger');
    await page.waitForSelector('text=New Trigger');

    // Hourly tab (default)
    await screenshot(page, 'trigger-form-hourly-desktop');

    // Daily tab
    await page.click('role=tab[name="Daily"]');
    await screenshot(page, 'trigger-form-daily-desktop');

    // Weekly tab
    await page.click('role=tab[name="Weekly"]');
    await screenshot(page, 'trigger-form-weekly-desktop');

    // Monthly tab
    await page.click('role=tab[name="Monthly"]');
    await screenshot(page, 'trigger-form-monthly-desktop');

    // Advanced tab
    await page.click('role=tab[name="Advanced"]');
    await screenshot(page, 'trigger-form-advanced-desktop');

    await assertNoOverflow(page);
  });
});
