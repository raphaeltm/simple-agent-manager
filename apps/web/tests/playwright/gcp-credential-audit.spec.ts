import { expect, type Page, type Route, test } from '@playwright/test';

import { assertNoOverflow, makeMockUser, screenshot } from './audit-helpers';

const MOCK_USER = makeMockUser({
  email: 'gcp-audit@example.com',
  name: 'GCP Credential Audit',
  role: 'superadmin',
  sessionId: 'session-gcp-credential-audit',
  userId: 'user-gcp-credential-audit',
});

const LONG_UNICODE_CREDENTIAL = {
  id: 'credential-gcp-service-account',
  provider: 'gcp',
  connected: true,
  createdAt: '2026-07-16T00:00:00.000Z',
  gcp: {
    authType: 'service-account-key',
    gcpProjectId: 'project-with-a-very-long-identifier-for-wrapping-世界-🚀-and-more-text',
    serviceAccountEmail:
      'sam-vm-manager-with-a-very-long-local-part@project-with-a-very-long-identifier.iam.gserviceaccount.com <script>alert("xss")</script>',
    defaultZone: 'europe-west3-a',
    privateKeyId: '0123456789abcdef'.repeat(10),
  },
};

const MALFORMED_METADATA_CREDENTIAL = {
  id: 'credential-gcp-malformed-metadata',
  provider: 'gcp',
  connected: true,
  createdAt: '2026-07-16T00:00:00.000Z',
};

type MockOptions = {
  credential?: typeof LONG_UNICODE_CREDENTIAL | typeof MALFORMED_METADATA_CREDENTIAL;
  saveError?: boolean;
};

async function setupMocks(page: Page, options: MockOptions = {}) {
  await page.addInitScript(() => {
    window.localStorage.setItem(
      'sam-onboarding-wizard-dismissed-user-gcp-credential-audit',
      'true'
    );
  });
  await page.route('**/api/**', async (route: Route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const respond = (status: number, body: unknown) =>
      route.fulfill({
        status,
        contentType: 'application/json',
        body: JSON.stringify(body),
      });

    if (path === '/api/gcp/service-account' && request.method() === 'PUT') {
      if (options.saveError) {
        return respond(403, {
          error: 'BAD_REQUEST',
          message:
            'Compute API is disabled or the service account lacks permission for this zone. Enable compute.googleapis.com and retry.',
        });
      }
      return respond(200, {
        success: true,
        credential: LONG_UNICODE_CREDENTIAL,
      });
    }
    if (path.includes('/api/auth/')) return respond(200, MOCK_USER);
    if (path === '/api/dashboard/active-tasks') return respond(200, { tasks: [] });
    if (path === '/api/trial-status' || path === '/api/trial/status') {
      return respond(200, { isTrial: false, available: false });
    }
    if (path === '/api/projects') return respond(200, { projects: [], total: 0 });
    if (path === '/api/credentials') {
      return respond(200, options.credential ? [options.credential] : []);
    }
    if (path === '/api/credentials/agent') return respond(200, { credentials: [] });
    if (path === '/api/notifications/unread-count') return respond(200, { count: 0 });
    if (path === '/api/notifications') {
      return respond(200, { notifications: [], unreadCount: 0, nextCursor: null });
    }
    return respond(200, {});
  });
}

async function gotoGoogleCloud(page: Page) {
  await page.goto('/settings/cloud-provider');
  const heading = page.getByRole('heading', { name: 'Google Cloud' });
  await expect(heading).toBeVisible();
  await heading.evaluate((element) => element.scrollIntoView({ block: 'start' }));
  await expect(page.getByText('Something went wrong')).toHaveCount(0);
}

test.describe('GCP service-account credential UI audit', () => {
  test('empty connection and key-policy warning states', async ({ page }) => {
    await setupMocks(page);
    await gotoGoogleCloud(page);

    await expect(page.getByText('Recommended')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Connect with Google' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Use service account JSON' })).toBeVisible();
    await assertNoOverflow(page);
    await screenshot(page, 'gcp-credential-empty');

    await page.getByRole('button', { name: 'Use service account JSON' }).click();
    await expect(page.getByText(/some organizations disable key creation by policy/)).toBeVisible();
    await expect(page.getByLabel('Choose JSON file')).toBeVisible();
    await expect(page.getByLabel('Or paste JSON')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Validate and connect' })).toBeVisible();
    await assertNoOverflow(page);
    await screenshot(page, 'gcp-credential-policy-warning');
  });

  test('sanitized validation error remains retryable', async ({ page }) => {
    await setupMocks(page, { saveError: true });
    await gotoGoogleCloud(page);
    await page.getByRole('button', { name: 'Use service account JSON' }).click();
    await page
      .getByLabel('Or paste JSON')
      .fill('{"type":"service_account","private_key":"not-shown"}');
    await page.getByRole('button', { name: 'Validate and connect' }).click();

    await expect(page.getByText(/Compute API is disabled/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Validate and connect' })).toBeVisible();
    await assertNoOverflow(page);
    await screenshot(page, 'gcp-credential-validation-error');
  });

  test('long unicode and HTML-like metadata wraps without becoming markup', async ({ page }) => {
    await setupMocks(page, { credential: LONG_UNICODE_CREDENTIAL });
    await gotoGoogleCloud(page);

    await expect(page.getByText('Service account JSON (long-lived key)')).toBeVisible();
    await expect(page.getByText(LONG_UNICODE_CREDENTIAL.gcp.gcpProjectId)).toBeVisible();
    await expect(page.getByText(/<script>alert\("xss"\)<\/script>/)).toBeVisible();
    await expect(page.getByText(LONG_UNICODE_CREDENTIAL.gcp.privateKeyId)).toBeVisible();
    await assertNoOverflow(page);
    await screenshot(page, 'gcp-credential-long-unicode');
  });

  test('malformed safe metadata degrades to a connected WIF summary', async ({ page }) => {
    await setupMocks(page, { credential: MALFORMED_METADATA_CREDENTIAL });
    await gotoGoogleCloud(page);

    await expect(page.getByText('Connected')).toBeVisible();
    await expect(page.getByText('Workload Identity Federation (recommended)')).toBeVisible();
    await expect(page.getByText('Private key ID')).toHaveCount(0);
    await assertNoOverflow(page);
    await screenshot(page, 'gcp-credential-malformed-metadata');
  });

  test('rotation requires confirmation and keeps the new JSON out of the dialog copy', async ({
    page,
  }) => {
    await setupMocks(page, { credential: LONG_UNICODE_CREDENTIAL });
    await gotoGoogleCloud(page);
    await page.getByRole('button', { name: 'Rotate JSON key' }).click();
    await expect(page.getByLabel('Or paste JSON')).toHaveValue('');
    await page
      .getByLabel('Or paste JSON')
      .fill('{"type":"service_account","private_key":"rotation-secret-never-render"}');
    await page.getByRole('button', { name: 'Validate and rotate key' }).click();

    const dialog = page.getByRole('dialog', {
      name: 'Rotate GCP service-account key?',
    });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('atomically replacing');
    await expect(dialog).not.toContainText('rotation-secret-never-render');
    await expect(dialog.getByRole('button', { name: 'Validate and rotate' })).toBeVisible();
    await assertNoOverflow(page);
    await screenshot(page, 'gcp-credential-rotation-confirm');
  });
});
