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

const NOW = Date.now();

interface NotifOverrides {
  id: string;
  type: string;
  title: string;
  body?: string | null;
  projectId?: string | null;
  readAt?: string | null;
  metadata?: Record<string, unknown> | null;
}

function makeNotification(o: NotifOverrides) {
  return {
    id: o.id,
    type: o.type,
    urgency: 'medium',
    title: o.title,
    body: o.body ?? null,
    projectId: o.projectId ?? 'proj-1',
    taskId: null,
    sessionId: null,
    actionUrl: null,
    metadata: o.metadata ?? { projectName: 'Backend API' },
    readAt: o.readAt ?? null,
    dismissedAt: null,
    createdAt: new Date(NOW - 60000).toISOString(),
  };
}

// Normal mixed notifications — 2 priority + 4 updates
const NORMAL_NOTIFICATIONS = [
  makeNotification({ id: 'n1', type: 'needs_input', title: 'Agent needs your input on task #42' }),
  makeNotification({ id: 'n2', type: 'task_complete', title: 'Deploy backend v2.1 completed' }),
  makeNotification({ id: 'n3', type: 'progress', title: 'Working on fixing auth flow' }),
  makeNotification({ id: 'n4', type: 'error', title: 'Build failed: missing dependency' }),
  makeNotification({ id: 'n5', type: 'session_ended', title: 'Agent session ended', readAt: new Date(NOW).toISOString() }),
  makeNotification({ id: 'n6', type: 'pr_created', title: 'PR #123 opened for review' }),
];

// Long text notifications
const LONG_TEXT_NOTIFICATIONS = [
  makeNotification({
    id: 'lt1',
    type: 'needs_input',
    title: 'Agent requires your input on the extremely complex database migration task that involves restructuring the entire schema and updating all downstream consumers which is a very long notification title',
    body: 'The migration involves 47 tables across 3 schemas and requires coordinated downtime with the frontend team. Please review the migration plan at /docs/migration-v3.md and confirm whether we should proceed with the blue-green deployment strategy.',
  }),
  makeNotification({
    id: 'lt2',
    type: 'task_complete',
    title: 'x'.repeat(300),
  }),
  makeNotification({
    id: 'lt3',
    type: 'progress',
    title: 'Working on: special chars <script>alert("xss")</script> & "quotes" and emojis ✨🚀',
  }),
];

// Many notifications (30+)
const MANY_NOTIFICATIONS = Array.from({ length: 35 }, (_, i) => {
  const types = ['needs_input', 'task_complete', 'progress', 'error', 'session_ended', 'pr_created'];
  const type = types[i % types.length];
  return makeNotification({
    id: `many-${i}`,
    type,
    title: `Notification ${i + 1}: ${type.replace('_', ' ')}`,
    readAt: i % 3 === 0 ? null : new Date(NOW).toISOString(),
  });
});

// Multi-project notifications (for grouping)
const MULTI_PROJECT_NOTIFICATIONS = [
  makeNotification({ id: 'mp1', type: 'needs_input', title: 'Input needed on auth', projectId: 'proj-1', metadata: { projectName: 'Backend API' } }),
  makeNotification({ id: 'mp2', type: 'task_complete', title: 'Deploy done', projectId: 'proj-1', metadata: { projectName: 'Backend API' } }),
  makeNotification({ id: 'mp3', type: 'needs_input', title: 'Review PR layout', projectId: 'proj-2', metadata: { projectName: 'Frontend App' } }),
  makeNotification({ id: 'mp4', type: 'progress', title: 'Building infra', projectId: 'proj-3', metadata: { projectName: 'Infrastructure' } }),
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function setupApiMocks(
  page: Page,
  options: {
    notifications?: ReturnType<typeof makeNotification>[];
    unreadCount?: number;
  },
) {
  const notifs = options.notifications ?? [];
  const unreadCount = options.unreadCount ?? notifs.filter((n) => !n.readAt).length;

  await page.route('**/api/**', async (route: Route) => {
    const url = route.request().url();
    const path = new URL(url).pathname;

    // Auth — catch all BetterAuth routes
    if (path.includes('/api/auth/')) {
      return route.fulfill({ json: MOCK_USER });
    }

    // Notifications
    if (path.includes('/api/notifications')) {
      return route.fulfill({
        json: { notifications: notifs, total: notifs.length, unreadCount },
      });
    }

    // Projects list
    if (path.match(/\/api\/projects\/?$/) || (path.includes('/api/projects') && !path.includes('/sessions'))) {
      return route.fulfill({ json: { projects: [], total: 0 } });
    }

    // Sessions
    if (path.includes('/sessions')) {
      return route.fulfill({ json: { sessions: [], total: 0 } });
    }

    // Tasks
    if (path.includes('/api/tasks')) {
      return route.fulfill({ json: { tasks: [], total: 0 } });
    }

    // Dashboard
    if (path.includes('/api/dashboard')) {
      return route.fulfill({ json: { tasks: [] } });
    }

    // Agents
    if (path.includes('/api/agents')) {
      return route.fulfill({ json: { agents: [] } });
    }

    // Credentials (Settings page expects a bare array)
    if (path.includes('/api/credentials')) {
      return route.fulfill({ json: [] });
    }

    // Smoke test status
    if (path.includes('/api/auth/smoke-test-status')) {
      return route.fulfill({ json: { enabled: false } });
    }

    // Catch-all: return empty object
    return route.fulfill({ status: 200, json: {} });
  });
}

async function screenshot(page: Page, name: string) {
  await page.waitForTimeout(600);
  await page.screenshot({
    path: `../../.codex/tmp/playwright-screenshots/${name}.png`,
    fullPage: true,
  });
}

async function openNotificationPanel(page: Page) {
  // Wait for the app to stabilize after auth check and initial render
  await page.waitForTimeout(1500);
  const bell = page.getByRole('button', { name: /notifications/i });
  await expect(bell).toBeVisible({ timeout: 5000 });
  await bell.click();
  const panel = page.locator('[role="dialog"][aria-label="Notifications"]');
  await panel.waitFor({ state: 'visible', timeout: 5000 });
  await page.waitForTimeout(300);
  return panel;
}

// ---------------------------------------------------------------------------
// Mobile tests (default viewport from playwright config)
// ---------------------------------------------------------------------------

test.describe('Notification tabs — Mobile', () => {
  test.use({ viewport: { width: 375, height: 667 }, isMobile: true });

  test('normal data — priority tab default', async ({ page }) => {
    await setupApiMocks(page, { notifications: NORMAL_NOTIFICATIONS });
    await page.goto('/');
    const panel = await openNotificationPanel(page);

    // Priority tab should be active by default
    await expect(panel.getByText('Agent needs your input on task #42')).toBeVisible();
    await expect(panel.getByText('Deploy backend v2.1 completed')).toBeVisible();

    // Updates should NOT be visible
    await expect(panel.getByText('Working on fixing auth flow')).not.toBeVisible();

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth,
    );
    expect(overflow).toBe(false);

    await screenshot(page, 'notif-tabs-priority-mobile');
  });

  test('normal data — updates tab', async ({ page }) => {
    await setupApiMocks(page, { notifications: NORMAL_NOTIFICATIONS });
    await page.goto('/');
    const panel = await openNotificationPanel(page);

    await panel.getByRole('tab', { name: /updates/i }).click();
    await page.waitForTimeout(300);

    await expect(panel.getByText('Working on fixing auth flow')).toBeVisible();
    await expect(panel.getByText('Build failed: missing dependency')).toBeVisible();

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth,
    );
    expect(overflow).toBe(false);

    await screenshot(page, 'notif-tabs-updates-mobile');
  });

  test('normal data — all tab', async ({ page }) => {
    await setupApiMocks(page, { notifications: NORMAL_NOTIFICATIONS });
    await page.goto('/');
    const panel = await openNotificationPanel(page);

    await panel.getByRole('tab', { name: /^all$/i }).click();
    await page.waitForTimeout(300);

    // All 6 should be visible
    await expect(panel.getByText('Agent needs your input on task #42')).toBeVisible();
    await expect(panel.getByText('PR #123 opened for review')).toBeVisible();

    await screenshot(page, 'notif-tabs-all-mobile');
  });

  test('long text wraps correctly', async ({ page }) => {
    await setupApiMocks(page, { notifications: LONG_TEXT_NOTIFICATIONS });
    await page.goto('/');
    await openNotificationPanel(page);

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth,
    );
    expect(overflow).toBe(false);

    await screenshot(page, 'notif-tabs-long-text-mobile');
  });

  test('empty state — priority tab', async ({ page }) => {
    const updatesOnly = [
      makeNotification({ id: 'e1', type: 'progress', title: 'Working on it' }),
    ];
    await setupApiMocks(page, { notifications: updatesOnly });
    await page.goto('/');
    const panel = await openNotificationPanel(page);

    await expect(panel.getByText(/no priority notifications/i)).toBeVisible();
    await expect(panel.getByText(/agent input requests and completed tasks/i)).toBeVisible();

    await screenshot(page, 'notif-tabs-empty-priority-mobile');
  });

  test('empty state — no notifications at all', async ({ page }) => {
    await setupApiMocks(page, { notifications: [] });
    await page.goto('/');
    const panel = await openNotificationPanel(page);

    await expect(panel.getByText(/no priority notifications/i)).toBeVisible();

    await screenshot(page, 'notif-tabs-empty-all-mobile');
  });

  test('many notifications scrolls correctly', async ({ page }) => {
    await setupApiMocks(page, { notifications: MANY_NOTIFICATIONS });
    await page.goto('/');
    await openNotificationPanel(page);

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth,
    );
    expect(overflow).toBe(false);

    await screenshot(page, 'notif-tabs-many-mobile');
  });
});

// ---------------------------------------------------------------------------
// Desktop tests
// ---------------------------------------------------------------------------

test.describe('Notification tabs — Desktop', () => {
  test.use({ viewport: { width: 1280, height: 800 }, isMobile: false });

  test('normal data — priority tab', async ({ page }) => {
    await setupApiMocks(page, { notifications: NORMAL_NOTIFICATIONS });
    await page.goto('/');
    const panel = await openNotificationPanel(page);

    await expect(panel.getByText('Agent needs your input on task #42')).toBeVisible();
    await expect(panel.getByText('Deploy backend v2.1 completed')).toBeVisible();
    await expect(panel.getByText('Working on fixing auth flow')).not.toBeVisible();

    await screenshot(page, 'notif-tabs-priority-desktop');
  });

  test('normal data — updates tab', async ({ page }) => {
    await setupApiMocks(page, { notifications: NORMAL_NOTIFICATIONS });
    await page.goto('/');
    const panel = await openNotificationPanel(page);

    await panel.getByRole('tab', { name: /updates/i }).click();
    await page.waitForTimeout(300);

    await expect(panel.getByText('Working on fixing auth flow')).toBeVisible();
    await expect(panel.getByText('Build failed: missing dependency')).toBeVisible();

    await screenshot(page, 'notif-tabs-updates-desktop');
  });

  test('long text', async ({ page }) => {
    await setupApiMocks(page, { notifications: LONG_TEXT_NOTIFICATIONS });
    await page.goto('/');
    await openNotificationPanel(page);

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth,
    );
    expect(overflow).toBe(false);

    await screenshot(page, 'notif-tabs-long-text-desktop');
  });

  test('multi-project grouping with tabs', async ({ page }) => {
    await setupApiMocks(page, { notifications: MULTI_PROJECT_NOTIFICATIONS });
    await page.goto('/');
    const panel = await openNotificationPanel(page);

    // Priority tab with multi-project grouping
    await expect(panel.getByText('Backend API')).toBeVisible();

    await screenshot(page, 'notif-tabs-grouped-desktop');
  });

  test('empty state', async ({ page }) => {
    await setupApiMocks(page, { notifications: [] });
    await page.goto('/');
    const panel = await openNotificationPanel(page);

    await expect(panel.getByText(/no priority notifications/i)).toBeVisible();

    await screenshot(page, 'notif-tabs-empty-desktop');
  });
});
