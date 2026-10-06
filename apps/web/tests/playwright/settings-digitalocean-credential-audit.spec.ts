import { expect, type Page, type Route, test } from '@playwright/test';

import {
  assertNoOverflow,
  getProjectSuffix,
  jsonResponse,
  makeMockUser,
  screenshot,
} from './audit-helpers';

const MOCK_USER = makeMockUser({
  email: 'digitalocean-audit@example.com',
  name: 'DigitalOcean Audit User',
  role: 'superadmin',
  sessionId: 'session-digitalocean-audit',
  userId: 'user-digitalocean-audit',
});

interface DigitalOceanAuditMockOptions {
  /** When true, GET /api/credentials returns a connected digitalocean credential. */
  existingDigitalOcean?: boolean;
  /** When set, POST /api/credentials/validate fails with this status + body (error path). */
  validateError?: { status: number; body: unknown };
  /** Consumers returned by GET /api/credentials/resolution-status (Connections page). */
  resolutionConsumers?: unknown[];
}

async function setupApiMocks(page: Page, options: DigitalOceanAuditMockOptions = {}) {
  const { existingDigitalOcean = false, validateError, resolutionConsumers } = options;
  await page.route('**/api/**', async (route: Route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const method = route.request().method();
    const respond = (status: number, body: unknown) => jsonResponse(route, status, body);

    if (path.includes('/api/auth/')) return respond(200, MOCK_USER);
    if (path.startsWith('/api/notifications'))
      return respond(200, { notifications: [], unreadCount: 0 });
    if (path === '/api/projects')
      return respond(200, {
        projects: [{ id: 'proj-1', name: 'DigitalOcean Project' }],
        nextCursor: null,
      });
    if (path === '/api/projects/proj-1')
      return respond(200, {
        id: 'proj-1',
        name: 'DigitalOcean Project',
        repository: null,
        defaultBranch: null,
        installationId: 'inst-1',
        defaultVmSize: null,
      });
    if (path === '/api/admin/platform-credentials' && method === 'GET')
      return respond(200, {
        credentials: [
          {
            id: 'platform-do',
            credentialType: 'cloud-provider',
            credentialKind: 'api-key',
            provider: 'digitalocean',
            agentType: null,
            label: 'Shared DigitalOcean',
            isEnabled: true,
            createdAt: '2026-07-23T00:00:00Z',
            updatedAt: '2026-07-23T00:00:00Z',
          },
        ],
      });
    if (path === '/api/providers/catalog')
      return respond(200, {
        catalogs: [
          {
            provider: 'digitalocean',
            defaultLocation: 'fra1',
            locations: [{ id: 'fra1', name: 'Frankfurt', country: 'DE' }],
            sizes: {
              small: { type: 's-2vcpu-4gb', price: '~/mo', vcpu: 2, ramGb: 4, storageGb: 80 },
            },
          },
        ],
      });
    if (path === '/api/github/repositories') return respond(200, { repositories: [] });
    if (path === '/api/github/branches') return respond(200, [{ name: 'main' }]);
    if (path === '/api/github/installations')
      return respond(200, [
        {
          id: 'inst-1',
          installationId: '100',
          accountName: 'sam-demo',
          accountType: 'organization',
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
        },
      ]);
    if (path === '/api/nodes') return respond(200, []);
    if (path === '/api/trial-status' || path === '/api/trial/status')
      return respond(200, { available: false });
    if (path === '/api/credentials/resolution-status') {
      return respond(200, { consumers: resolutionConsumers ?? [] });
    }
    if (path === '/api/credentials' && method === 'GET') {
      return respond(
        200,
        existingDigitalOcean
          ? [
              {
                id: 'cred-digitalocean',
                provider: 'digitalocean',
                name: 'DigitalOcean',
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
        provider: 'digitalocean',
        message: 'DigitalOcean credential validated.',
      });
    }
    if (path === '/api/credentials' && method === 'POST') {
      return respond(200, { id: 'cred-digitalocean', provider: 'digitalocean', connected: true });
    }

    return respond(200, {});
  });
}

test.describe('Settings DigitalOcean credential audit', () => {
  test('add-form renders, full-access token guidance wraps, actions fit mobile + desktop', async ({
    page,
  }, testInfo) => {
    await setupApiMocks(page, { existingDigitalOcean: false });
    await page.goto('/settings/cloud-provider');
    await page.waitForTimeout(1000);

    const suffix = getProjectSuffix(testInfo.project.name);

    // The SettingsCloudProvider page renders every provider form at once, so scope
    // button queries to the DigitalOcean <section> (multiple "Test connection" buttons exist).
    const digitaloceanSection = page.locator('section', {
      has: page.getByRole('heading', { name: 'DigitalOcean' }),
    });

    await expect(page.getByRole('heading', { name: 'DigitalOcean' })).toBeVisible();
    await expect(page.getByLabel('DigitalOcean API Key')).toBeVisible();
    // The Full Access PAT guidance is intentionally long — must wrap, not overflow
    await expect(page.getByText('Full Access')).toBeVisible();

    await page.getByLabel('DigitalOcean API Key').fill(`digitalocean-${'key-'.repeat(48)}`);
    // exact:true — "Connect" is a substring of "Test connection".
    await expect(
      digitaloceanSection.getByRole('button', { name: 'Test connection', exact: true })
    ).toBeVisible();
    await expect(
      digitaloceanSection.getByRole('button', { name: 'Connect', exact: true })
    ).toBeVisible();
    await screenshot(page, `settings-digitalocean-add-${suffix}`);
    await assertNoOverflow(page);

    await digitaloceanSection.getByRole('button', { name: 'Test connection', exact: true }).click();
    await expect(page.getByText('DigitalOcean credential validated.')).toBeVisible();
    await screenshot(page, `settings-digitalocean-validated-${suffix}`);
    await assertNoOverflow(page);
  });

  test('validation error surfaces an error alert without overflow', async ({ page }, testInfo) => {
    await setupApiMocks(page, {
      existingDigitalOcean: false,
      validateError: {
        status: 400,
        body: {
          error: 'CREDENTIAL_VALIDATION_FAILED',
          message: 'Token rejected by DigitalOcean API (401 Unauthorized)',
        },
      },
    });
    await page.goto('/settings/cloud-provider');
    await page.waitForTimeout(1000);

    const suffix = getProjectSuffix(testInfo.project.name);
    const digitaloceanSection = page.locator('section', {
      has: page.getByRole('heading', { name: 'DigitalOcean' }),
    });

    await expect(page.getByLabel('DigitalOcean API Key')).toBeVisible();
    await page.getByLabel('DigitalOcean API Key').fill('bogus-digitalocean-token');
    // exact:true — "Connect" is a substring of "Test connection".
    await digitaloceanSection.getByRole('button', { name: 'Test connection', exact: true }).click();

    // The rejected validation must surface as a visible error Alert in the DigitalOcean form.
    await expect(
      digitaloceanSection.getByText('Token rejected by DigitalOcean API (401 Unauthorized)')
    ).toBeVisible();
    await screenshot(page, `settings-digitalocean-validation-error-${suffix}`);
    await assertNoOverflow(page);
  });

  test('connected state (existing credential) fits mobile + desktop', async ({
    page,
  }, testInfo) => {
    await setupApiMocks(page, { existingDigitalOcean: true });
    await page.goto('/settings/cloud-provider');
    await page.waitForTimeout(1000);

    const suffix = getProjectSuffix(testInfo.project.name);
    await expect(page.getByRole('heading', { name: 'DigitalOcean' })).toBeVisible();
    // Connected state shows Disconnect within the DigitalOcean section
    await expect(page.getByText('Connected').first()).toBeVisible();
    await screenshot(page, `settings-digitalocean-connected-${suffix}`);
    await assertNoOverflow(page);
  });

  test('cloud provider connect-flow 5-provider grid fits mobile + desktop with DigitalOcean selected', async ({
    page,
  }, testInfo) => {
    // The CloudProviderConnectFlow grid was changed from sm:grid-cols-3 to sm:grid-cols-2
    // (balanced 2x2 for 5 providers). Render it via the Connections page → an unresolved
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

    // All five providers render in the 2x2 grid; select DigitalOcean.
    await expect(page.getByRole('button', { name: /^DigitalOcean Global cloud/ })).toBeVisible();
    await page.getByRole('button', { name: /^DigitalOcean Global cloud/ }).click();
    await expect(page.getByLabel(/DigitalOcean API key/i)).toBeVisible();

    await screenshot(page, `settings-digitalocean-connectflow-grid-${suffix}`);
    await assertNoOverflow(page);
  });
  test('admin option and workspace availability render DigitalOcean at mobile + desktop', async ({
    page,
  }, testInfo) => {
    await setupApiMocks(page, { existingDigitalOcean: true });
    const suffix = getProjectSuffix(testInfo.project.name);

    await page.goto('/admin/credentials');
    await expect(page.getByText('Shared DigitalOcean')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Delete Shared DigitalOcean' })).toBeVisible();
    await page.getByRole('button', { name: 'Add Credential' }).click();
    await expect(page.getByLabel('Provider')).toContainText('DigitalOcean');
    await screenshot(page, 'settings-digitalocean-admin-' + suffix);
    await assertNoOverflow(page);

    await page.goto('/workspaces/new');
    await page.locator('main').getByRole('combobox').first().selectOption('proj-1');
    await expect(page.getByLabel('Workspace Name')).toBeVisible();
    await expect(page.getByText('(DigitalOcean)', { exact: true })).toBeVisible();
    await screenshot(page, 'settings-digitalocean-workspace-' + suffix);
    await assertNoOverflow(page);
  });
});
