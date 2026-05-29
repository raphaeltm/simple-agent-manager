import { expect, type Page, type Route, test } from '@playwright/test';

import { assertNoOverflow, getProjectSuffix, jsonResponse, makeMockUser, screenshot } from './audit-helpers';

const MOCK_USER = makeMockUser({
  email: 'auth-flows-audit@example.com',
  name: 'Auth Audit User',
  sessionId: 'session-auth-flows-audit',
  userId: 'user-auth-flows-audit',
});

async function setupAuthenticatedMocks(page: Page) {
  await page.route('**/api/**', async (route: Route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const method = route.request().method();
    const respond = (status: number, body: unknown) => jsonResponse(route, status, body);

    if (path.includes('/api/auth/get-session') || path.includes('/api/auth/session')) {
      return respond(200, MOCK_USER);
    }
    if (path === '/api/auth/device/approve' && method === 'POST') {
      return respond(200, { success: true });
    }
    if (path === '/api/auth/api-tokens' && method === 'GET') {
      return respond(200, [
        {
          id: 'token-active',
          name: 'Laptop CLI',
          createdAt: '2026-05-28T12:00:00Z',
          lastUsedAt: '2026-05-29T12:00:00Z',
          revokedAt: null,
        },
      ]);
    }
    if (path === '/api/auth/api-tokens' && method === 'POST') {
      return respond(200, {
        id: 'token-new',
        token: 'sam_pat_1234567890abcdef1234567890abcdef',
        name: 'Visual audit CLI',
        createdAt: '2026-05-29T12:00:00Z',
      });
    }
    if (path.startsWith('/api/notifications')) {
      return respond(200, { notifications: [], unreadCount: 0 });
    }
    if (path === '/api/projects') {
      return respond(200, { projects: [], nextCursor: null });
    }

    return respond(200, {});
  });
}

test.describe('CLI auth UI audit', () => {
  test('device approval page fits mobile and desktop', async ({ page }, testInfo) => {
    await setupAuthenticatedMocks(page);
    await page.goto('/device?code=ABCD-1234');

    await expect(page.getByRole('heading', { name: 'Authorize SAM CLI' })).toBeVisible();
    await expect(page.locator('input[value="ABCD-1234"]')).toBeVisible();
    await screenshot(page, `device-auth-${getProjectSuffix(testInfo.project.name)}`);
    await assertNoOverflow(page);

    await page.getByRole('button', { name: 'Authorize', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'CLI authorized' })).toBeVisible();
    await screenshot(page, `device-auth-success-${getProjectSuffix(testInfo.project.name)}`);
    await assertNoOverflow(page);
  });

  test('settings API tokens workflow fits mobile and desktop', async ({ page }, testInfo) => {
    await setupAuthenticatedMocks(page);
    await page.goto('/settings/api-tokens');

    await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'API Tokens' })).toBeVisible();
    await expect(page.getByText('Laptop CLI')).toBeVisible();
    await screenshot(page, `settings-api-tokens-${getProjectSuffix(testInfo.project.name)}`);
    await assertNoOverflow(page);

    await page.getByRole('button', { name: 'Generate New Token' }).click();
    await page.getByPlaceholder('e.g., Work laptop CLI').fill('Visual audit CLI');
    await page.getByRole('button', { name: 'Generate', exact: true }).click();

    await expect(page.getByText('Token Generated')).toBeVisible();
    await expect(page.getByText('sam_pat_1234567890abcdef1234567890abcdef')).toBeVisible();
    await screenshot(page, `settings-api-tokens-generated-${getProjectSuffix(testInfo.project.name)}`);
    await assertNoOverflow(page);
  });
});
