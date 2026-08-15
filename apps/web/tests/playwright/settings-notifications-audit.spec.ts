import { expect, type Page, type Route, test } from '@playwright/test';

import { assertNoOverflow, jsonResponse, makeMockUser, screenshot } from './audit-helpers';

// ---------------------------------------------------------------------------
// Mock Data Factories
// ---------------------------------------------------------------------------

const MOCK_USER = makeMockUser({
  userId: 'user-test-1',
  sessionId: 'session-test-1',
  email: 'test@example.com',
  name: 'Test User',
  role: 'superadmin',
});

type NotificationType =
  | 'task_complete'
  | 'needs_input'
  | 'error'
  | 'progress'
  | 'session_ended'
  | 'pr_created'
  | 'cron_failure';

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
    notifications?: unknown[];
  } = {}
) {
  const {
    preferences = [],
    preferencesError = false,
    saveError = false,
    notifications = [],
  } = options;

  await page.route('**/api/**', async (route: Route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const method = route.request().method();

    const respond = (status: number, body: unknown) => jsonResponse(route, status, body);

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
    if (path === '/api/notifications/unread-count') {
      return respond(200, { count: notifications.length });
    }
    if (path === '/api/notifications') {
      return respond(200, {
        notifications,
        unreadCount: notifications.length,
        nextCursor: null,
      });
    }
    if (path.includes('/attention/') && path.endsWith('/resolve')) {
      return respond(200, { resolved: true, alreadyResolved: false, answer: 'Approve' });
    }
    if (path.startsWith('/api/notifications')) {
      return respond(200, { subscriptions: [] });
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

async function navigateToNotificationSettings(page: Page) {
  await page.goto('/settings/notifications');
  await page.waitForTimeout(1000);
}

// ===========================================================================
// NOTIFICATION SETTINGS — Mobile (375x667, default from config)
// ===========================================================================

test.describe('Notification Settings — Mobile', () => {
  test('default state: all seven type toggles render enabled', async ({ page }) => {
    await setupApiMocks(page, { preferences: [] });
    await navigateToNotificationSettings(page);
    await page.waitForSelector('[role="switch"]');
    await screenshot(page, 'notification-settings-mobile-default');
    await assertNoOverflow(page);

    const switches = page.getByRole('switch');
    await expect(switches).toHaveCount(8);
    for (let i = 0; i < 7; i++) {
      await expect(switches.nth(i)).toHaveAttribute('aria-checked', 'true');
    }
    await expect(switches.nth(7)).toHaveAttribute('aria-checked', 'false');
    await expect(page.getByRole('heading', { name: 'Push Notifications' })).toBeVisible();
    await expect(page.getByRole('switch', { name: 'Enable Web Push notifications' })).toBeVisible();
    await expect(page.getByText('Install SAM')).toBeVisible();
    for (let i = 0; i < (await switches.count()); i++) {
      const box = await switches.nth(i).boundingBox();
      expect(box?.width).toBeGreaterThanOrEqual(44);
      expect(box?.height).toBeGreaterThanOrEqual(44);
    }
    await page.getByRole('heading', { name: 'Push Notifications' }).scrollIntoViewIfNeeded();
    await screenshot(page, 'notification-settings-mobile-push-card');
    await assertNoOverflow(page);
  });

  test('reflects a global type-specific disable', async ({ page }) => {
    await setupApiMocks(page, { preferences: [globalPref('task_complete', false)] });
    await navigateToNotificationSettings(page);
    await page.waitForSelector('[role="switch"]');
    await screenshot(page, 'notification-settings-mobile-type-disabled');
    await assertNoOverflow(page);

    const taskCompleteSwitch = page.getByRole('switch', { name: /Task Complete/i });
    await expect(taskCompleteSwitch).toHaveAttribute('aria-checked', 'false');
  });

  test('wildcard global disable turns all toggles off', async ({ page }) => {
    await setupApiMocks(page, { preferences: [globalPref('*', false)] });
    await navigateToNotificationSettings(page);
    await page.waitForSelector('[role="switch"]');
    await screenshot(page, 'notification-settings-mobile-wildcard-disabled');
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
    await screenshot(page, 'notification-settings-mobile-load-error');
    await assertNoOverflow(page);

    const alert = page
      .getByRole('alert')
      .filter({ hasText: /Could not load notification preferences/i });
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

    const alert = page.getByRole('alert').filter({ hasText: /Task Complete/i });
    await expect(alert).toBeVisible();
    await expect(alert).toContainText(/Task Complete/);
    await screenshot(page, 'notification-settings-mobile-save-error');
    await assertNoOverflow(page);

    // Switch state did NOT optimistically change to the rejected value
    await expect(page.getByRole('switch', { name: /Task Complete/i })).toHaveAttribute(
      'aria-checked',
      'true'
    );
  });

  test('project-scoped rows do not affect the global toggle', async ({ page }) => {
    await setupApiMocks(page, {
      preferences: [
        {
          notificationType: 'task_complete',
          projectId: 'proj-9',
          channel: 'in_app',
          enabled: false,
        },
      ],
    });
    await navigateToNotificationSettings(page);
    await page.waitForSelector('[role="switch"]');
    await screenshot(page, 'notification-settings-mobile-project-scoped-ignored');
    await assertNoOverflow(page);

    const taskCompleteSwitch = page.getByRole('switch', { name: /Task Complete/i });
    await expect(taskCompleteSwitch).toHaveAttribute('aria-checked', 'true');
  });

  test('structured answers remain keyboard-safe and contained with a long mobile option', async ({
    page,
  }) => {
    const longOption = 'A'.repeat(200);
    await setupApiMocks(page, {
      notifications: [
        {
          id: 'needs-input-1',
          type: 'needs_input',
          urgency: 'high',
          title: 'Agent needs a release decision',
          body: 'Choose how to proceed.',
          projectId: 'proj-1',
          taskId: 'task-1',
          sessionId: 'session-1',
          actionUrl: '/projects/proj-1/chat/session-1',
          metadata: { attentionMarkerId: 'marker-1', options: [longOption, 'Reject'] },
          readAt: null,
          dismissedAt: null,
          createdAt: '2026-08-11T00:00:00.000Z',
        },
      ],
    });
    await navigateToNotificationSettings(page);
    await page.getByRole('button', { name: /need attention/i }).click();
    const option = page.getByRole('button', { name: longOption });
    await expect(option).toBeVisible();
    await option.focus();
    await expect(option).toBeFocused();
    await screenshot(page, 'notification-center-mobile-structured-answer');
    await assertNoOverflow(page);
    const box = await option.boundingBox();
    expect(box?.width).toBeLessThanOrEqual(375);
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
    await screenshot(page, 'notification-settings-desktop-default');
    await assertNoOverflow(page);

    const switches = page.getByRole('switch');
    await expect(switches).toHaveCount(8);
    await expect(page.getByRole('heading', { name: 'Push Notifications' })).toBeVisible();
    await expect(page.getByRole('switch', { name: 'Enable Web Push notifications' })).toBeVisible();
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
    await screenshot(page, 'notification-settings-desktop-mixed');
    await assertNoOverflow(page);

    await expect(page.getByRole('switch', { name: /Task Complete/i })).toHaveAttribute(
      'aria-checked',
      'false'
    );
    await expect(page.getByRole('switch', { name: /Progress Update/i })).toHaveAttribute(
      'aria-checked',
      'false'
    );
  });

  test('notification switches are keyboard operable and retain visible content', async ({
    page,
  }) => {
    await setupApiMocks(page, { preferences: [] });
    await navigateToNotificationSettings(page);

    const taskCompleteSwitch = page.getByRole('switch', { name: /Task Complete/i });
    await taskCompleteSwitch.focus();
    await expect(taskCompleteSwitch).toBeFocused();
    await taskCompleteSwitch.press('Space');
    await expect(taskCompleteSwitch).toHaveAttribute('aria-checked', 'false');
    await expect(page.getByRole('heading', { name: 'In-App Notifications' })).toBeVisible();
    await assertNoOverflow(page);
  });

  test('structured answer panel fits the desktop viewport', async ({ page }) => {
    await setupApiMocks(page, {
      notifications: [
        {
          id: 'needs-input-desktop',
          type: 'needs_input',
          urgency: 'high',
          title: 'Agent needs a release decision',
          body: 'Choose how to proceed.',
          projectId: 'proj-1',
          taskId: 'task-1',
          sessionId: 'session-1',
          actionUrl: '/projects/proj-1/chat/session-1',
          metadata: { attentionMarkerId: 'marker-1', options: ['Approve', 'Reject'] },
          readAt: null,
          dismissedAt: null,
          createdAt: '2026-08-11T00:00:00.000Z',
        },
      ],
    });
    await navigateToNotificationSettings(page);
    await page.getByRole('button', { name: /need attention/i }).click();
    await expect(page.getByRole('button', { name: 'Approve' })).toBeVisible();
    await screenshot(page, 'notification-center-desktop-structured-answer');
    await assertNoOverflow(page);
  });

  test('load failure renders accessible alert on desktop', async ({ page }) => {
    await setupApiMocks(page, { preferencesError: true });
    await navigateToNotificationSettings(page);
    await screenshot(page, 'notification-settings-desktop-load-error');
    await assertNoOverflow(page);

    await expect(
      page.getByRole('alert').filter({ hasText: /Could not load notification preferences/i })
    ).toBeVisible();
  });
});
