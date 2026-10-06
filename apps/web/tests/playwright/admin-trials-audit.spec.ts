import { expect, type Page, type Route, test } from '@playwright/test';

import {
  assertNoOverflow,
  makeMockUser,
  screenshot,
  setupAuditRoutes,
} from './audit-helpers';

const ADMIN_USER = makeMockUser({
  email: 'admin@example.com',
  name: 'Admin User',
  role: 'superadmin',
  sessionId: 'session-admin-trials',
  userId: 'user-admin-trials',
});

interface TrialConfigMock {
  enabled: boolean;
  kvKey: string;
  cacheTtlMs: number;
}

async function respondJson(route: Route, status: number, body: unknown) {
  await route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
}

async function setupMocks(page: Page, config: TrialConfigMock) {
  await setupAuditRoutes(page, (path, respond) => {
    if (path === '/api/auth/get-session') {
      return respond(200, ADMIN_USER);
    }

    if (path === '/api/dashboard/active-tasks') return respond(200, { tasks: [] });
    if (path === '/api/trial-status') return respond(200, { isTrial: false });
    if (path === '/api/projects') return respond(200, { projects: [], total: 0 });
    if (path === '/api/notifications/unread-count') return respond(200, { count: 0 });
    if (path === '/api/notifications') {
      return respond(200, { notifications: [], unreadCount: 0, nextCursor: null });
    }

    if (path === '/api/admin/trials/config') {
      return respond(200, config);
    }

    return undefined;
  });
}

async function setupStatefulToggleMocks(page: Page, initialConfig: TrialConfigMock) {
  let config = { ...initialConfig };
  const patchBodies: unknown[] = [];
  let configGetCount = 0;

  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;

    if (path === '/api/auth/get-session') return respondJson(route, 200, ADMIN_USER);
    if (path === '/api/dashboard/active-tasks') return respondJson(route, 200, { tasks: [] });
    if (path === '/api/trial-status') return respondJson(route, 200, { isTrial: false });
    if (path === '/api/projects') return respondJson(route, 200, { projects: [], total: 0 });
    if (path === '/api/notifications/unread-count') return respondJson(route, 200, { count: 0 });
    if (path === '/api/notifications') {
      return respondJson(route, 200, { notifications: [], unreadCount: 0, nextCursor: null });
    }

    if (path === '/api/admin/trials/config' && request.method() === 'GET') {
      configGetCount += 1;
      return respondJson(route, 200, config);
    }

    if (path === '/api/admin/trials/config' && request.method() === 'PATCH') {
      const body = request.postDataJSON();
      patchBodies.push(body);
      config = { ...config, enabled: body.enabled };
      return respondJson(route, 200, config);
    }

    return respondJson(route, 200, {});
  });

  return {
    getConfigGetCount: () => configGetCount,
    getPatchBodies: () => patchBodies,
  };
}

async function captureTrialsPage(page: Page, name: string, expectedText = 'Trial onboarding') {
  await page.goto('/admin/trials');
  await page.waitForTimeout(700);
  await expect(page.getByText('Something went wrong')).toHaveCount(0);
  await expect(page.getByRole('tab', { name: 'Trials', selected: true })).toBeVisible();
  await expect(page.getByText(expectedText)).toBeVisible();
  await screenshot(page, name);
  await assertNoOverflow(page);
}

test.describe('AdminTrials', () => {
  test('enabled state', async ({ page }) => {
    await setupMocks(page, {
      enabled: true,
      kvKey: 'trials:enabled',
      cacheTtlMs: 30000,
    });
    await captureTrialsPage(page, 'admin-trials-enabled');
  });

  test('disabled state with long KV key', async ({ page }) => {
    await setupMocks(page, {
      enabled: false,
      kvKey: 'operator:controls:trial-onboarding:enabled:very-long-diagnostic-key',
      cacheTtlMs: 120000,
    });
    await captureTrialsPage(page, 'admin-trials-disabled-long-key');
  });

  test('toggle flow persists through the admin config API', async ({ page }) => {
    const api = await setupStatefulToggleMocks(page, {
      enabled: true,
      kvKey: 'trials:enabled',
      cacheTtlMs: 30000,
    });

    await page.goto('/admin/trials');
    await expect(page.getByText('Accepting trials')).toBeVisible();

    await page.getByRole('button', { name: 'Pause trials' }).click();
    await expect(page.getByText('Trials paused')).toBeVisible();
    expect(api.getPatchBodies()).toEqual([{ enabled: false }]);

    await page.getByRole('button', { name: 'Refresh' }).click();
    await expect(page.getByText('Trials paused')).toBeVisible();
    expect(api.getConfigGetCount()).toBeGreaterThanOrEqual(2);
  });

  test('error state', async ({ page }) => {
    await setupAuditRoutes(page, (path, respond) => {
      if (path === '/api/auth/get-session') return respond(200, ADMIN_USER);
      if (path === '/api/dashboard/active-tasks') return respond(200, { tasks: [] });
      if (path === '/api/trial-status') return respond(200, { isTrial: false });
      if (path === '/api/projects') return respond(200, { projects: [], total: 0 });
      if (path === '/api/notifications/unread-count') return respond(200, { count: 0 });
      if (path === '/api/notifications') {
        return respond(200, { notifications: [], unreadCount: 0, nextCursor: null });
      }
      if (path === '/api/admin/trials/config') {
        return respond(500, { error: 'INTERNAL_ERROR', message: 'KV read failed' });
      }
      return undefined;
    });
    await captureTrialsPage(page, 'admin-trials-error', 'KV read failed');
  });
});
