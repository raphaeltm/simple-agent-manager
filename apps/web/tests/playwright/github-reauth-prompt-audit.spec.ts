import { expect, type Page, type Route, test } from '@playwright/test';

import { assertNoOverflow, getProjectSuffix, jsonResponse, makeMockUser, screenshot } from './audit-helpers';

const MOCK_USER = makeMockUser({
  email: 'github-reauth-audit@example.com',
  name: 'GitHub Reauth Audit',
  role: 'superadmin',
  sessionId: 'session-github-reauth-audit',
  userId: 'user-github-reauth-audit',
});

async function setupAuthenticatedMocks(page: Page) {
  await page.route('**/api/**', async (route: Route) => {
    const path = new URL(route.request().url()).pathname;
    const respond = (status: number, body: unknown) => jsonResponse(route, status, body);

    if (path.includes('/api/auth/get-session') || path.includes('/api/auth/session')) {
      return respond(200, MOCK_USER);
    }
    if (path.startsWith('/api/notifications')) {
      return respond(200, { notifications: [], unreadCount: 0 });
    }
    if (path === '/api/projects') {
      return respond(200, { projects: [], nextCursor: null });
    }
    if (path === '/api/trial/status') {
      return respond(200, { available: false });
    }

    return respond(200, {});
  });
}

test.describe('GitHub reauth prompt audit', () => {
  test('surfaces an actionable reauth prompt without overflow', async ({ page }, testInfo) => {
    await setupAuthenticatedMocks(page);
    await page.goto('/projects');
    await expect(page.getByRole('heading', { name: 'Projects' })).toBeVisible();

    await page.evaluate(() => {
      window.dispatchEvent(new CustomEvent('sam:github-reauth-required', {
        detail: {
          message: 'Your GitHub authorization has expired — please sign out and back in',
        },
      }));
    });

    await expect(page.getByRole('alert')).toBeVisible();
    await expect(page.getByText('GitHub sign-in required')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Sign out and reconnect' })).toBeVisible();

    await screenshot(page, `github-reauth-prompt-${getProjectSuffix(testInfo.project.name)}`);
    await assertNoOverflow(page);
  });
});
