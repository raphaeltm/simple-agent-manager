import { expect, type Page, type Route, test } from '@playwright/test';

import {
  assertNoOverflow,
  getProjectSuffix,
  jsonResponse,
  makeMockUser,
  screenshot,
} from './audit-helpers';

const MOCK_USER = makeMockUser({
  email: 'vultr-audit@example.com',
  name: 'Vultr Audit User',
  sessionId: 'session-vultr-audit',
  userId: 'user-vultr-audit',
});

/** @param existingVultr when true, GET /api/credentials returns a connected vultr credential. */
async function setupApiMocks(page: Page, existingVultr: boolean) {
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
      return respond(
        200,
        existingVultr
          ? [
              {
                id: 'cred-vultr',
                provider: 'vultr',
                name: 'Vultr',
                createdAt: '2026-07-23T00:00:00Z',
                updatedAt: '2026-07-23T00:00:00Z',
              },
            ]
          : []
      );
    }
    if (path === '/api/credentials/validate' && method === 'POST') {
      return respond(200, {
        valid: true,
        provider: 'vultr',
        message: 'Vultr credential validated.',
      });
    }
    if (path === '/api/credentials' && method === 'POST') {
      return respond(200, { id: 'cred-vultr', provider: 'vultr', connected: true });
    }

    return respond(200, {});
  });
}

test.describe('Settings Vultr credential audit', () => {
  test('add-form renders, long IP-allowlist hint wraps, actions fit mobile + desktop', async ({
    page,
  }, testInfo) => {
    await setupApiMocks(page, false);
    await page.goto('/settings/cloud-provider');
    await page.waitForTimeout(1000);

    const suffix = getProjectSuffix(testInfo.project.name);

    // The SettingsCloudProvider page renders every provider form at once, so scope
    // button queries to the Vultr <section> (multiple "Test connection" buttons exist).
    const vultrSection = page.locator('section', {
      has: page.getByRole('heading', { name: 'Vultr' }),
    });

    await expect(page.getByRole('heading', { name: 'Vultr' })).toBeVisible();
    await expect(page.getByLabel('Vultr API Key')).toBeVisible();
    // The IP-allowlist warning is the new (longer) help text — must wrap, not overflow
    await expect(page.getByText('Allow All IPv4/IPv6')).toBeVisible();

    await page.getByLabel('Vultr API Key').fill(`vultr-${'key-'.repeat(48)}`);
    // exact:true — "Connect" is a substring of "Test connection".
    await expect(vultrSection.getByRole('button', { name: 'Test connection', exact: true })).toBeVisible();
    await expect(vultrSection.getByRole('button', { name: 'Connect', exact: true })).toBeVisible();
    await screenshot(page, `settings-vultr-add-${suffix}`);
    await assertNoOverflow(page);

    await vultrSection.getByRole('button', { name: 'Test connection', exact: true }).click();
    await expect(page.getByText('Vultr credential validated.')).toBeVisible();
    await screenshot(page, `settings-vultr-validated-${suffix}`);
    await assertNoOverflow(page);
  });

  test('connected state (existing credential) fits mobile + desktop', async ({ page }, testInfo) => {
    await setupApiMocks(page, true);
    await page.goto('/settings/cloud-provider');
    await page.waitForTimeout(1000);

    const suffix = getProjectSuffix(testInfo.project.name);
    await expect(page.getByRole('heading', { name: 'Vultr' })).toBeVisible();
    // Connected state shows Disconnect within the Vultr section
    await expect(page.getByText('Connected').first()).toBeVisible();
    await screenshot(page, `settings-vultr-connected-${suffix}`);
    await assertNoOverflow(page);
  });
});
