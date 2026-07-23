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

interface VultrAuditMockOptions {
  /** When true, GET /api/credentials returns a connected vultr credential. */
  existingVultr?: boolean;
  /** When set, POST /api/credentials/validate fails with this status + body (error path). */
  validateError?: { status: number; body: unknown };
  /** Consumers returned by GET /api/credentials/resolution-status (Connections page). */
  resolutionConsumers?: unknown[];
}

async function setupApiMocks(page: Page, options: VultrAuditMockOptions = {}) {
  const { existingVultr = false, validateError, resolutionConsumers } = options;
  await page.route('**/api/**', async (route: Route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const method = route.request().method();
    const respond = (status: number, body: unknown) => jsonResponse(route, status, body);

    if (path.includes('/api/auth/')) return respond(200, MOCK_USER);
    if (path.startsWith('/api/notifications'))
      return respond(200, { notifications: [], unreadCount: 0 });
    if (path === '/api/projects') return respond(200, { projects: [], nextCursor: null });
    if (path === '/api/credentials/resolution-status') {
      return respond(200, { consumers: resolutionConsumers ?? [] });
    }
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
      if (validateError) return respond(validateError.status, validateError.body);
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
    await setupApiMocks(page, { existingVultr: false });
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

  test('validation error surfaces an error alert without overflow', async ({ page }, testInfo) => {
    await setupApiMocks(page, {
      existingVultr: false,
      validateError: {
        status: 400,
        body: {
          error: 'CREDENTIAL_VALIDATION_FAILED',
          message: 'Token rejected by Vultr API (401 Unauthorized)',
        },
      },
    });
    await page.goto('/settings/cloud-provider');
    await page.waitForTimeout(1000);

    const suffix = getProjectSuffix(testInfo.project.name);
    const vultrSection = page.locator('section', {
      has: page.getByRole('heading', { name: 'Vultr' }),
    });

    await expect(page.getByLabel('Vultr API Key')).toBeVisible();
    await page.getByLabel('Vultr API Key').fill('bogus-vultr-token');
    // exact:true — "Connect" is a substring of "Test connection".
    await vultrSection.getByRole('button', { name: 'Test connection', exact: true }).click();

    // The rejected validation must surface as a visible error Alert in the Vultr form.
    await expect(
      vultrSection.getByText('Token rejected by Vultr API (401 Unauthorized)')
    ).toBeVisible();
    await screenshot(page, `settings-vultr-validation-error-${suffix}`);
    await assertNoOverflow(page);
  });

  test('connected state (existing credential) fits mobile + desktop', async ({ page }, testInfo) => {
    await setupApiMocks(page, { existingVultr: true });
    await page.goto('/settings/cloud-provider');
    await page.waitForTimeout(1000);

    const suffix = getProjectSuffix(testInfo.project.name);
    await expect(page.getByRole('heading', { name: 'Vultr' })).toBeVisible();
    // Connected state shows Disconnect within the Vultr section
    await expect(page.getByText('Connected').first()).toBeVisible();
    await screenshot(page, `settings-vultr-connected-${suffix}`);
    await assertNoOverflow(page);
  });

  test('cloud provider connect-flow 4-provider grid fits mobile + desktop with Vultr selected', async ({
    page,
  }, testInfo) => {
    // The CloudProviderConnectFlow grid was changed from sm:grid-cols-3 to sm:grid-cols-2
    // (balanced 2x2 for 4 providers). Render it via the Connections page → an unresolved
    // compute row's "Make default" action opens the flow.
    await setupApiMocks(page, {
      resolutionConsumers: [
        {
          consumerId: 'hetzner',
          consumerKind: 'compute',
          consumerName: 'Hetzner',
          source: 'unresolved',
          credentialName: null,
          halted: false,
        },
      ],
    });
    await page.goto('/settings/connections');
    await page.waitForTimeout(1000);

    const suffix = getProjectSuffix(testInfo.project.name);

    // Open the cloud provider connect flow (renders the 4-provider picker grid).
    await page.getByRole('button', { name: 'Make default' }).click();

    // All four providers render in the 2x2 grid; select Vultr.
    await expect(page.getByRole('button', { name: 'Vultr' })).toBeVisible();
    await page.getByRole('button', { name: 'Vultr' }).click();
    await expect(page.getByLabel(/Vultr API key/i)).toBeVisible();

    await screenshot(page, `settings-vultr-connectflow-grid-${suffix}`);
    await assertNoOverflow(page);
  });
});
