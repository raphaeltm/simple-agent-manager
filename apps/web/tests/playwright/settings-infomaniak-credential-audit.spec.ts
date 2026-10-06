import { expect, type Page, type Route, test } from '@playwright/test';

import {
  assertNoOverflow,
  getProjectSuffix,
  jsonResponse,
  makeMockUser,
  screenshot,
} from './audit-helpers';

const MOCK_USER = makeMockUser({
  email: 'infomaniak-audit@example.com',
  name: 'Infomaniak Audit User',
  sessionId: 'session-infomaniak-audit',
  userId: 'user-infomaniak-audit',
});

interface InfomaniakAuditMockOptions {
  /** When true, GET /api/credentials returns a connected infomaniak credential. */
  existingInfomaniak?: boolean;
  /** When set, POST /api/credentials/validate fails with this status + body (error path). */
  validateError?: { status: number; body: unknown };
  /** Consumers returned by GET /api/credentials/resolution-status (Connections page). */
  resolutionConsumers?: unknown[];
}

async function setupApiMocks(page: Page, options: InfomaniakAuditMockOptions = {}) {
  const { existingInfomaniak = false, validateError, resolutionConsumers } = options;
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
        existingInfomaniak
          ? [
              {
                id: 'cred-infomaniak',
                provider: 'infomaniak',
                name: 'Infomaniak',
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
        provider: 'infomaniak',
        message: 'Infomaniak application credential validated.',
      });
    }
    if (path === '/api/credentials' && method === 'POST') {
      if (validateError) return respond(validateError.status, validateError.body);
      return respond(200, {
        id: 'cred-infomaniak',
        provider: 'infomaniak',
        connected: true,
        validation: { valid: true, message: 'Infomaniak application credential validated.' },
      });
    }

    return respond(200, {});
  });
}

test.describe('Settings Infomaniak credential audit', () => {
  test('add-form renders, long application-credential hint wraps, actions fit mobile + desktop', async ({
    page,
  }, testInfo) => {
    await setupApiMocks(page, { existingInfomaniak: false });
    await page.goto('/settings/cloud-provider');
    await expect(page.getByRole('heading', { name: 'Infomaniak Public Cloud' })).toBeVisible();

    const suffix = getProjectSuffix(testInfo.project.name);

    // The SettingsCloudProvider page renders every provider form at once, so scope
    // button queries to the Infomaniak <section> (multiple "Test connection" buttons exist).
    const infomaniakSection = page.locator('section', {
      has: page.getByRole('heading', { name: 'Infomaniak Public Cloud' }),
    });

    await expect(page.getByRole('heading', { name: 'Infomaniak Public Cloud' })).toBeVisible();
    await expect(page.getByLabel('Application Credential Secret')).toBeVisible();
    // The application-credential warning is the new (longer) help text — must wrap, not overflow
    await expect(page.getByText('reader and member roles')).toBeVisible();

    await page.getByLabel('Application Credential ID').fill('app-id-with-unicode-🇨🇭');
    await page.getByLabel('Application Credential Secret').fill(`infomaniak-${'key-'.repeat(48)}`);
    // exact:true — "Connect" is a substring of "Test connection".
    await expect(
      infomaniakSection.getByRole('button', { name: 'Connect', exact: true })
    ).toBeVisible();
    await screenshot(page, `settings-infomaniak-add-${suffix}`);
    await assertNoOverflow(page);

    await infomaniakSection.getByRole('button', { name: 'Connect', exact: true }).click();
    await expect(page.getByText('Infomaniak application credential validated.')).toBeVisible();
    await screenshot(page, `settings-infomaniak-validated-${suffix}`);
    await assertNoOverflow(page);
  });

  test('validation error surfaces an error alert without overflow', async ({ page }, testInfo) => {
    await setupApiMocks(page, {
      existingInfomaniak: false,
      validateError: {
        status: 400,
        body: {
          error: 'CREDENTIAL_VALIDATION_FAILED',
          message: 'Application credential rejected by Infomaniak API (401 Unauthorized)',
        },
      },
    });
    await page.goto('/settings/cloud-provider');
    await expect(page.getByRole('heading', { name: 'Infomaniak Public Cloud' })).toBeVisible();

    const suffix = getProjectSuffix(testInfo.project.name);
    const infomaniakSection = page.locator('section', {
      has: page.getByRole('heading', { name: 'Infomaniak Public Cloud' }),
    });

    await expect(page.getByLabel('Application Credential Secret')).toBeVisible();
    await page.getByLabel('Application Credential ID').fill('app-id-with-unicode-🇨🇭');
    await page.getByLabel('Application Credential Secret').fill('bogus-infomaniak-token');
    // exact:true — "Connect" is a substring of "Test connection".
    await infomaniakSection.getByRole('button', { name: 'Connect', exact: true }).click();

    // The rejected validation must surface as a visible error Alert in the Infomaniak form.
    await expect(
      infomaniakSection.getByText(
        'Application credential rejected by Infomaniak API (401 Unauthorized)'
      )
    ).toBeVisible();
    await screenshot(page, `settings-infomaniak-validation-error-${suffix}`);
    await assertNoOverflow(page);
  });

  test('connected state (existing credential) fits mobile + desktop', async ({
    page,
  }, testInfo) => {
    await setupApiMocks(page, { existingInfomaniak: true });
    await page.goto('/settings/cloud-provider');
    await expect(page.getByRole('heading', { name: 'Infomaniak Public Cloud' })).toBeVisible();

    const suffix = getProjectSuffix(testInfo.project.name);
    // Connected state shows Disconnect within the Infomaniak section
    await expect(page.getByText('Connected').first()).toBeVisible();
    await screenshot(page, `settings-infomaniak-connected-${suffix}`);
    await assertNoOverflow(page);
  });

  test('cloud provider connect-flow 4-provider grid fits mobile + desktop with Infomaniak selected', async ({
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
    await expect(page.getByRole('button', { name: 'Make default' })).toBeVisible();

    const suffix = getProjectSuffix(testInfo.project.name);

    // Open the cloud provider connect flow (renders the 4-provider picker grid).
    await page.getByRole('button', { name: 'Make default' }).click();

    // All four providers render in the 2x2 grid; select Infomaniak.
    await expect(page.getByRole('button', { name: /Infomaniak Public Cloud/ })).toBeVisible();
    await page.getByRole('button', { name: /Infomaniak Public Cloud/ }).click();
    await expect(page.getByLabel(/Application credential secret/i)).toBeVisible();

    await screenshot(page, `settings-infomaniak-connectflow-grid-${suffix}`);
    await assertNoOverflow(page);
  });
});
