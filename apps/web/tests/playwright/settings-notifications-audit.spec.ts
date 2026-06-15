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

type NotificationType =
  | 'task_complete'
  | 'needs_input'
  | 'error'
  | 'progress'
  | 'session_ended'
  | 'pr_created';

interface PreferenceMock {
  notificationType: NotificationType | '*';
  projectId: string | null;
  channel: 'in_app';
  enabled: boolean;
}

function globalPref(
  notificationType: PreferenceMock['notificationType'],
  enabled: boolean
): PreferenceMock {
  return { notificationType, projectId: null, channel: 'in_app', enabled };
}

// ---------------------------------------------------------------------------
// API Mock Setup
// ---------------------------------------------------------------------------

async function setupApiMocks(
  page: Page,
  options: {
    preferences?: PreferenceMock[];
    preferencesError?: boolean;
    saveError?: boolean;
  } = {}
) {
  const { preferences = [], preferencesError = false, saveError = false } = options;

  await page.route('**/api/**', async (route: Route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const method = route.request().method();

    const respond = (status: number, body: unknown) =>
      route.fulfill({
        status,
        contentType: 'application/json',
        body: JSON.stringify(body),
      });

    // Auth (BetterAuth get-session and other auth routes)
    if (path.includes('/api/auth/')) {
      return respond(200, MOCK_USER);
    }

    // Notification preferences (read + update)
    if (path === '/api/notifications/preferences') {
      if (method === 'PUT') {
        if (saveError) {
          return respond(500, { error: 'Failed to save preference' });
        }
        return respond(200, {});
      }
      if (preferencesError) {
        return respond(500, { error: 'Failed to load preferences' });
      }
      return respond(200, { preferences });
    }

    // Notification feed / unread count (sidebar bell, etc.)
    if (path.startsWith('/api/notifications')) {
      return respond(200, { notifications: [], unreadCount: 0, count: 0 });
    }

    // Projects
    if (path === '/api/projects') {
      return respond(200, { projects: [] });
    }

    // Health
    if (path.endsWith('/health')) {
      return respond(200, { status: 'ok' });
    }

    // Catch-all
    return respond(200, {});
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
  await page.waitForTimeout(600);
  await page.screenshot({
    path: `../../.codex/tmp/playwright-screenshots/${name}.png`,
    fullPage: true,
  });
}

async function navigateToNotificationSettings(page: Page) {
  await page.goto('/settings/notifications');
  await page.waitForTimeout(1000);
}

// ===========================================================================
// NOTIFICATION SETTINGS — Mobile (375x667, default from config)
// ===========================================================================

test.describe('Notification Settings — Mobile', () => {
  test('default state: all six type toggles render enabled', async ({ page }) => {
    await setupApiMocks(page, { preferences: [] });
    await navigateToNotificationSettings(page);
    await page.waitForSelector('[role="switch"]');
    await takeScreenshot(page, 'notification-settings-mobile-default');
    await assertNoOverflow(page);

    const switches = page.getByRole('switch');
    await expect(switches).toHaveCount(6);
    const count = await switches.count();
    for (let i = 0; i < count; i++) {
      await expect(switches.nth(i)).toHaveAttribute('aria-checked', 'true');
    }
  });

  test('reflects a global type-specific disable', async ({ page }) => {
    await setupApiMocks(page, { preferences: [globalPref('task_complete', false)] });
    await navigateToNotificationSettings(page);
    await page.waitForSelector('[role="switch"]');
    await takeScreenshot(page, 'notification-settings-mobile-type-disabled');
    await assertNoOverflow(page);

    const taskCompleteSwitch = page.getByRole('switch', { name: /Task Complete/i });
    await expect(taskCompleteSwitch).toHaveAttribute('aria-checked', 'false');
  });

  test('wildcard global disable turns all toggles off', async ({ page }) => {
    await setupApiMocks(page, { preferences: [globalPref('*', false)] });
    await navigateToNotificationSettings(page);
    await page.waitForSelector('[role="switch"]');
    await takeScreenshot(page, 'notification-settings-mobile-wildcard-disabled');
    await assertNoOverflow(page);

    const switches = page.getByRole('switch');
    const count = await switches.count();
    for (let i = 0; i < count; i++) {
      await expect(switches.nth(i)).toHaveAttribute('aria-checked', 'false');
    }
  });

  test('load failure surfaces an accessible alert with Retry control', async ({ page }) => {
    await setupApiMocks(page, { preferencesError: true });
    await navigateToNotificationSettings(page);
    await takeScreenshot(page, 'notification-settings-mobile-load-error');
    await assertNoOverflow(page);

    const alert = page.getByRole('alert');
    await expect(alert).toBeVisible();
    await expect(alert).toContainText(/Could not load notification preferences/i);
    await expect(page.getByRole('button', { name: /Retry/i })).toBeVisible();
  });

  test('save failure surfaces an accessible alert without flipping the switch', async ({
    page,
  }) => {
    await setupApiMocks(page, { preferences: [], saveError: true });
    await navigateToNotificationSettings(page);
    await page.waitForSelector('[role="switch"]');

    const taskCompleteSwitch = page.getByRole('switch', { name: /Task Complete/i });
    await expect(taskCompleteSwitch).toHaveAttribute('aria-checked', 'true');
    await taskCompleteSwitch.click();

    const alert = page.getByRole('alert');
    await expect(alert).toBeVisible();
    await expect(alert).toContainText(/Task Complete/);
    await takeScreenshot(page, 'notification-settings-mobile-save-error');
    await assertNoOverflow(page);

    // Switch state did NOT optimistically change to the rejected value
    await expect(
      page.getByRole('switch', { name: /Task Complete/i })
    ).toHaveAttribute('aria-checked', 'true');
  });

  test('project-scoped rows do not affect the global toggle', async ({ page }) => {
    await setupApiMocks(page, {
      preferences: [
        { notificationType: 'task_complete', projectId: 'proj-9', channel: 'in_app', enabled: false },
      ],
    });
    await navigateToNotificationSettings(page);
    await page.waitForSelector('[role="switch"]');
    await takeScreenshot(page, 'notification-settings-mobile-project-scoped-ignored');
    await assertNoOverflow(page);

    const taskCompleteSwitch = page.getByRole('switch', { name: /Task Complete/i });
    await expect(taskCompleteSwitch).toHaveAttribute('aria-checked', 'true');
  });
});

// ===========================================================================
// NOTIFICATION SETTINGS — Desktop (1280x800)
// ===========================================================================

test.describe('Notification Settings — Desktop', () => {
  test.use({ viewport: { width: 1280, height: 800 }, isMobile: false });

  test('default state renders without overflow on desktop', async ({ page }) => {
    await setupApiMocks(page, { preferences: [] });
    await navigateToNotificationSettings(page);
    await page.waitForSelector('[role="switch"]');
    await takeScreenshot(page, 'notification-settings-desktop-default');
    await assertNoOverflow(page);

    const switches = page.getByRole('switch');
    await expect(switches).toHaveCount(6);
  });

  test('mixed preferences render correctly on desktop', async ({ page }) => {
    await setupApiMocks(page, {
      preferences: [
        globalPref('task_complete', false),
        globalPref('error', true),
        globalPref('progress', false),
      ],
    });
    await navigateToNotificationSettings(page);
    await page.waitForSelector('[role="switch"]');
    await takeScreenshot(page, 'notification-settings-desktop-mixed');
    await assertNoOverflow(page);

    await expect(
      page.getByRole('switch', { name: /Task Complete/i })
    ).toHaveAttribute('aria-checked', 'false');
    await expect(
      page.getByRole('switch', { name: /Progress Update/i })
    ).toHaveAttribute('aria-checked', 'false');
  });

  test('load failure renders accessible alert on desktop', async ({ page }) => {
    await setupApiMocks(page, { preferencesError: true });
    await navigateToNotificationSettings(page);
    await takeScreenshot(page, 'notification-settings-desktop-load-error');
    await assertNoOverflow(page);

    await expect(page.getByRole('alert')).toContainText(
      /Could not load notification preferences/i
    );
  });
});
