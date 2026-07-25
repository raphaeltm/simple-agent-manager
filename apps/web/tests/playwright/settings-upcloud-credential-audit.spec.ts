import { expect, type Page, type Route, test } from '@playwright/test';

import {
  assertNoOverflow,
  getProjectSuffix,
  jsonResponse,
  makeMockUser,
  screenshot,
} from './audit-helpers';
const USER = makeMockUser({
  email: 'upcloud-audit@example.com',
  name: 'UpCloud Audit User',
  sessionId: 'session-upcloud',
  userId: 'user-upcloud',
});
async function mocks(page: Page, connected = false) {
  await page.route('**/api/**', async (route: Route) => {
    const path = new URL(route.request().url()).pathname,
      method = route.request().method();
    const respond = (status: number, body: unknown) => jsonResponse(route, status, body);
    if (path.includes('/api/auth/')) return respond(200, USER);
    if (path.startsWith('/api/notifications'))
      return respond(200, { notifications: [], unreadCount: 0 });
    if (path === '/api/projects') return respond(200, { projects: [], nextCursor: null });
    if (path === '/api/credentials/resolution-status')
      return respond(200, {
        consumers: [
          {
            consumerId: 'upcloud',
            consumerKind: 'compute',
            consumerName: 'UpCloud',
            source: 'unresolved',
            credentialName: null,
            halted: false,
          },
        ],
      });
    if (path === '/api/credentials' && method === 'GET')
      return respond(
        200,
        connected
          ? [
              {
                id: 'upcloud-1',
                provider: 'upcloud',
                connected: true,
                createdAt: '2026-07-25T00:00:00Z',
              },
            ]
          : []
      );
    if (path === '/api/credentials' && method === 'POST')
      return respond(201, {
        id: 'upcloud-1',
        provider: 'upcloud',
        connected: true,
        validation: { valid: true, message: 'UpCloud credential validated.' },
      });
    return respond(200, {});
  });
}
test.describe('Settings UpCloud credential audit', () => {
  test('username/password form fits mobile and desktop', async ({ page }, info) => {
    await mocks(page);
    await page.goto('/settings/cloud-provider');
    const section = page.locator('section', {
      has: page.getByRole('heading', { name: 'UpCloud' }),
    });
    await expect(section.getByLabel('API Username')).toBeVisible();
    await expect(section.getByLabel('Password')).toBeVisible();
    await section.getByLabel('API Username').fill('api-user-' + 'long-'.repeat(40));
    await section.getByLabel('Password').fill('secret');
    await screenshot(page, `settings-upcloud-add-${getProjectSuffix(info.project.name)}`);
    await assertNoOverflow(page);
  });
  test('connected state fits mobile and desktop', async ({ page }, info) => {
    await mocks(page, true);
    await page.goto('/settings/cloud-provider');
    const section = page.locator('section', {
      has: page.getByRole('heading', { name: 'UpCloud' }),
    });
    await expect(section.getByRole('button', { name: 'Disconnect UpCloud account' })).toBeVisible();
    await screenshot(page, `settings-upcloud-connected-${getProjectSuffix(info.project.name)}`);
    await assertNoOverflow(page);
  });
  test('five-provider connect grid exposes structured UpCloud fields', async ({ page }, info) => {
    await mocks(page);
    await page.goto('/settings/connections');
    await page.getByRole('button', { name: 'Make default' }).click();
    await page.getByRole('button', { name: 'UpCloud' }).click();
    await expect(page.getByLabel('UpCloud API username')).toBeVisible();
    await expect(page.getByLabel('UpCloud API password')).toBeVisible();
    await screenshot(page, `settings-upcloud-connect-${getProjectSuffix(info.project.name)}`);
    await assertNoOverflow(page);
  });
});
