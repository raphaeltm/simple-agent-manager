import { expect, type Page, type Route, test } from '@playwright/test';

import {
  assertNoOverflow,
  getProjectSuffix,
  jsonResponse,
  makeMockUser,
  screenshot,
} from './audit-helpers';

const MOCK_USER = makeMockUser({
  email: 'settings-audit@example.com',
  name: 'Settings Audit User',
  sessionId: 'session-settings-audit',
  userId: 'user-settings-audit',
});

async function setupApiMocks(page: Page) {
  await page.route('**/api/**', async (route: Route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const method = route.request().method();
    const respond = (status: number, body: unknown) => jsonResponse(route, status, body);

    if (path.includes('/api/auth/')) return respond(200, MOCK_USER);
    if (path.startsWith('/api/notifications'))
      return respond(200, { notifications: [], unreadCount: 0 });
    if (path === '/api/projects') return respond(200, { projects: [], nextCursor: null });
    if (path === '/api/credentials' && method === 'GET') {
      return respond(200, [
        {
          id: 'cred-hetzner',
          provider: 'hetzner',
          name: 'Hetzner',
          createdAt: '2026-04-19T00:00:00Z',
          updatedAt: '2026-04-19T00:00:00Z',
        },
      ]);
    }
    if (path === '/api/credentials/validate' && method === 'POST') {
      return respond(200, {
        valid: true,
        provider: 'hetzner',
        message: 'hetzner credential validated.',
      });
    }
    if (path === '/api/credentials' && method === 'POST') {
      return respond(200, { id: 'cred-hetzner', provider: 'hetzner', connected: true });
    }

    return respond(200, {});
  });
}

test.describe('Settings Hetzner validation audit', () => {
  test('update form validation actions fit mobile and desktop', async ({ page }, testInfo) => {
    await setupApiMocks(page);
    await page.goto('/settings/cloud-provider');
    await page.waitForTimeout(1000);

    const suffix = getProjectSuffix(testInfo.project.name);
    await expect(page.getByText('Hetzner')).toBeVisible();
    await page.getByRole('button', { name: 'Update' }).click();
    await page.getByLabel('Hetzner API Token').fill(`hetzner-${'token-'.repeat(42)}`);
    await expect(page.getByRole('button', { name: 'Test connection' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Update Token' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Cancel' })).toBeVisible();
    await screenshot(page, `settings-hetzner-validation-${suffix}`);
    await assertNoOverflow(page);

    await page.getByRole('button', { name: 'Test connection' }).click();
    await expect(page.getByText('hetzner credential validated.')).toBeVisible();
    await screenshot(page, `settings-hetzner-validation-success-${suffix}`);
    await assertNoOverflow(page);
  });
});
