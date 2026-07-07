import { expect, type Page, type Route, test } from '@playwright/test';

import { assertNoOverflow, makeMockUser, screenshot } from './audit-helpers';

const ADMIN_USER = makeMockUser({
  email: 'admin@example.com',
  name: 'Admin User',
  role: 'superadmin',
  sessionId: 'session-platform-config',
  userId: 'admin-platform-config',
});

const PLATFORM_STATUS = {
  setupCompleted: false,
  setupForced: false,
  integrations: {
    githubOAuth: {
      configured: true,
      source: 'environment',
      label: 'set via GitHub secret',
      fields: {
        clientId: { configured: true, source: 'environment', updatedAt: null, updatedBy: null },
        clientSecret: { configured: true, source: 'environment', updatedAt: null, updatedBy: null },
      },
    },
    githubApp: {
      configured: true,
      source: 'environment',
      label: 'set via GitHub secret',
      fields: {
        appId: { configured: true, source: 'environment', updatedAt: null, updatedBy: null },
        appPrivateKey: { configured: true, source: 'environment', updatedAt: null, updatedBy: null },
        appSlug: { configured: true, source: 'environment', updatedAt: null, updatedBy: null },
      },
    },
    githubWebhook: {
      configured: false,
      source: 'unset',
      label: 'not configured',
      fields: {
        webhookSecret: { configured: false, source: 'unset', updatedAt: null, updatedBy: null },
      },
    },
    googleOAuth: {
      configured: true,
      source: 'runtime',
      label: 'set here',
      fields: {
        clientId: { configured: true, source: 'runtime', updatedAt: '2026-07-07T00:00:00Z', updatedBy: 'admin-platform-config' },
        clientSecret: { configured: true, source: 'runtime', updatedAt: '2026-07-07T00:00:00Z', updatedBy: 'admin-platform-config' },
      },
    },
  },
};

async function respondJson(route: Route, status: number, body: unknown) {
  await route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
}

async function setupMocks(page: Page, authenticated = true, googleLogin = true) {
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;

    if (path === '/api/auth/get-session') return respondJson(route, 200, authenticated ? ADMIN_USER : null);
    if (path === '/api/config/login-providers') {
      return respondJson(route, 200, { github: true, google: googleLogin });
    }
    if (path === '/api/dashboard/active-tasks') return respondJson(route, 200, { tasks: [] });
    if (path === '/api/trial-status') return respondJson(route, 200, { isTrial: false });
    if (path === '/api/projects') return respondJson(route, 200, { projects: [], total: 0 });
    if (path === '/api/notifications/unread-count') return respondJson(route, 200, { count: 0 });
    if (path === '/api/notifications') {
      return respondJson(route, 200, { notifications: [], unreadCount: 0, nextCursor: null });
    }

    if (path === '/api/setup/status') {
      return respondJson(route, 200, {
        completed: false,
        open: true,
        forced: false,
        tokenConfigured: true,
      });
    }

    if (path === '/api/setup/verify') {
      return respondJson(route, 200, { ok: true, status: PLATFORM_STATUS });
    }

    if (path === '/api/setup/config' && request.method() === 'PUT') {
      return respondJson(route, 200, { status: PLATFORM_STATUS });
    }

    if (path === '/api/admin/platform-config') {
      return respondJson(route, 200, { status: PLATFORM_STATUS });
    }

    return respondJson(route, 200, {});
  });
}

test.describe('Platform config first-run and admin UI', () => {
  test('setup token unlock shows integration sources', async ({ page }) => {
    await setupMocks(page);
    await page.goto('/setup');
    await page.getByLabel('Setup token').fill('test-setup-token');
    await page.getByRole('button', { name: 'Verify token' }).click();
    await expect(page.getByTestId('platform-config-form')).toBeVisible();
    await expect(page.getByText('set via GitHub secret').first()).toBeVisible();
    await expect(page.getByText('set here').first()).toBeVisible();
    await expect(page.getByText('not configured').first()).toBeVisible();
    await assertNoOverflow(page);
    await screenshot(page, 'platform-config-setup');
  });

  test('admin integrations page shows the shared config store', async ({ page }) => {
    await setupMocks(page);
    await page.goto('/admin/integrations');
    await expect(page.getByRole('heading', { name: 'Admin' })).toBeVisible();
    await expect(page.getByTestId('platform-config-form')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Save integrations' })).toBeVisible();
    await assertNoOverflow(page);
    await screenshot(page, 'platform-config-admin');
  });

  test('login surfaces include Google sign-in', async ({ page }) => {
    await setupMocks(page, false);

    await page.goto('/');
    await expect(page.getByRole('button', { name: 'Sign in with GitHub' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Sign in with Google' })).toBeVisible();
    await assertNoOverflow(page);
    await screenshot(page, 'platform-config-landing-login');

    await page.goto('/device?code=ABCD-1234');
    await expect(page.getByRole('button', { name: 'Log in with GitHub' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Log in with Google' })).toBeVisible();
    await assertNoOverflow(page);
    await screenshot(page, 'platform-config-device-login');

    await page.goto('/__test/trial-chat-gate?ideas=3&loginOpen=1');
    await expect(page.getByTestId('trial-login-github')).toBeVisible();
    await expect(page.getByTestId('trial-login-google')).toBeVisible();
    await assertNoOverflow(page);
    await screenshot(page, 'platform-config-trial-login-sheet');
  });

  test('login surfaces hide Google when the login client is not configured', async ({ page }) => {
    await setupMocks(page, false, false);

    await page.goto('/');
    await expect(page.getByRole('button', { name: 'Sign in with GitHub' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Sign in with Google' })).toHaveCount(0);

    await page.goto('/device?code=ABCD-1234');
    await expect(page.getByRole('button', { name: 'Log in with GitHub' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Log in with Google' })).toHaveCount(0);

    await page.goto('/__test/trial-chat-gate?ideas=3&loginOpen=1');
    await expect(page.getByTestId('trial-login-github')).toBeVisible();
    await expect(page.getByTestId('trial-login-google')).toHaveCount(0);
  });
});
