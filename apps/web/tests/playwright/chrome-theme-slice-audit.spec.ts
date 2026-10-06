import { expect, type Page, type Route, test } from '@playwright/test';

const MOCK_USER = {
  user: {
    id: 'user-test-1',
    email: 'test@example.com',
    name: 'Test User With A Long Display Name For Chrome Wrapping',
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

const MOCK_STANDARD = {
  id: 'std-1',
  version: 'v1.0',
  status: 'active',
  name: 'SAM Unified UI Standard',
  visualDirection: 'Green-forward, software-development-focused, high-clarity workflows',
  mobileFirstRulesRef: 'docs/guides/mobile-ux-guidelines.md',
  accessibilityRulesRef: 'docs/guides/ui-standards.md#accessibility-requirements',
  ownerRole: 'design-engineering-lead',
};

const MOCK_PROJECTS = [
  {
    id: 'proj-test-1',
    name: 'Very Long Project Name That Exercises Navigation Truncation Without Overflow',
    repository: 'testuser/repository-with-a-long-name',
    status: 'active',
    taskCounts: { active: 2, total: 12 },
    lastActivityAt: '2026-06-06T12:00:00Z',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-06-06T12:00:00Z',
  },
];

const MOCK_NOTIFICATIONS = [
  {
    id: 'notif-1',
    type: 'needs_input',
    urgency: 'high',
    title:
      'Agent needs input on a very long task title that must wrap inside the notification center without pushing the panel wider than the viewport',
    body:
      'Please review whether to continue with the migration. This body includes special characters <script>alert("xss")</script>, emoji, and a long URL https://example.com/a/very/long/path/that/should/wrap/in/the/panel.',
    projectId: 'proj-test-1',
    taskId: null,
    sessionId: null,
    actionUrl: null,
    metadata: { projectName: 'Very Long Project Name That Exercises Navigation Truncation Without Overflow' },
    readAt: null,
    dismissedAt: null,
    createdAt: '2026-06-06T12:00:00Z',
  },
  {
    id: 'notif-2',
    type: 'task_complete',
    urgency: 'medium',
    title: 'Background update completed',
    body: 'The shared chrome token audit generated an update.',
    projectId: 'proj-test-1',
    taskId: null,
    sessionId: null,
    actionUrl: null,
    metadata: { projectName: 'Very Long Project Name That Exercises Navigation Truncation Without Overflow' },
    readAt: null,
    dismissedAt: null,
    createdAt: '2026-06-06T11:55:00Z',
  },
];

async function seedTheme(page: Page, theme: 'dark' | 'light') {
  await page.addInitScript((value) => {
    window.localStorage.setItem('sam-theme', value);
  }, theme);
}

async function setupApiMocks(page: Page) {
  await page.route('**/api/**', async (route: Route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const respond = (body: unknown, status = 200) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

    if (path.includes('/api/auth/')) return respond(MOCK_USER);
    if (path.startsWith('/api/notifications')) {
      return respond({ notifications: MOCK_NOTIFICATIONS, total: MOCK_NOTIFICATIONS.length, unreadCount: 2 });
    }
    if (path === '/api/ui-governance/standards/active') return respond(MOCK_STANDARD);
    if (path === '/api/projects') return respond({ projects: MOCK_PROJECTS, nextCursor: null });
    if (path === '/api/dashboard/active-tasks') return respond({ tasks: [] });
    if (path === '/api/credentials') return respond([]);
    if (path === '/api/github/installations') return respond([]);
    if (path === '/api/agents') return respond({ agents: [] });
    if (path === '/api/trial/status') return respond({ available: false });
    if (path.startsWith('/api/projects/')) return respond(MOCK_PROJECTS[0]);

    return respond({});
  });
}

async function expectNoOverflow(page: Page) {
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
}

async function screenshot(page: Page, name: string) {
  await page.waitForTimeout(600);
  await page.screenshot({
    path: `../../.codex/tmp/playwright-screenshots/${name}.png`,
    fullPage: true,
  });
}

async function openNotifications(page: Page) {
  const bell = page.getByRole('button', { name: /notifications/i }).first();
  await expect(bell).toBeVisible();
  await bell.click();
  await expect(page.getByRole('dialog', { name: 'Notifications' })).toBeVisible();
}

async function openCommandPalette(page: Page) {
  await page.getByRole('button', { name: /open command palette/i }).click();
  await expect(page.getByRole('dialog', { name: /command palette/i })).toBeVisible();
}

async function auditChrome(theme: 'dark' | 'light', page: Page, viewportName: 'mobile' | 'desktop') {
  await seedTheme(page, theme);
  await setupApiMocks(page);
  await page.goto('/ui-standards');
  await page.waitForLoadState('networkidle');

  await expect(page.locator('html')).toHaveAttribute('data-ui-theme', theme === 'dark' ? 'sam' : 'sam-light');
  await expectNoOverflow(page);

  if (viewportName === 'mobile') {
    await page.getByRole('button', { name: 'Open navigation menu' }).click();
    await expect(page.getByTestId('mobile-nav-panel')).toBeVisible();
    await screenshot(page, `chrome-slice-${theme}-mobile-drawer`);
    await page.keyboard.press('Escape');
    await openNotifications(page);
    await screenshot(page, `chrome-slice-${theme}-mobile-notifications`);
  } else {
    await openNotifications(page);
    await screenshot(page, `chrome-slice-${theme}-desktop-notifications`);
    await page.keyboard.press('Escape');
    await openCommandPalette(page);
    await screenshot(page, `chrome-slice-${theme}-desktop-command-palette`);
  }

  await expectNoOverflow(page);
}

function viewportNameFromProject(projectName: string): 'mobile' | 'desktop' {
  return projectName.includes('Desktop') ? 'desktop' : 'mobile';
}

test.describe('Chrome theme slice', () => {
  test('dark chrome surfaces render without overflow', async ({ page }) => {
    await auditChrome('dark', page, viewportNameFromProject(test.info().project.name));
  });

  test('light chrome surfaces render without overflow', async ({ page }) => {
    await auditChrome('light', page, viewportNameFromProject(test.info().project.name));
  });
});
