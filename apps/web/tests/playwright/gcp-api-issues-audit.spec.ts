/**
 * Visual audit for required-Google-API warnings:
 *   - the Settings → Infrastructure banner (`GcpApiIssuesBanner`)
 *   - the Google Cloud connection card's notice (`GcpApiIssuesNotice`), reached from the banner's
 *     Review button the way a user reaches it
 *
 * `GET /api/credentials` carries `gcp.apiIssues` exactly as the API returns it.
 */
import { expect, type Page, test } from '@playwright/test';

import { accountRows } from '../unit/components/accounts/fixtures';
import {
  assertNoOverflow,
  type AuditResponder,
  makeMockUser,
  respondToAppShellRoute,
  screenshot,
  setupAuditRoutes,
} from './audit-helpers';

const USER = makeMockUser({
  email: 'raphael@example.com',
  name: 'Raphaël',
  sessionId: 'session-gcp-api-issues',
  userId: 'user-gcp-api-issues',
});

const BILLING_OFF = {
  service: 'cloudbilling.googleapis.com',
  label: 'Cloud Billing',
  reason: 'api_disabled',
  observedAt: '2026-11-07T23:10:47.052Z',
};

/** Google caps project ids at 30 characters; this is the longest shape. */
const LONG_PROJECT = 'acme-corporation-production-01';

interface Scenario {
  authType?: 'workload-identity' | 'service-account-key';
  gcpProjectId?: string;
  apiIssues?: unknown[];
  failCredentials?: boolean;
}

function gcpCredential(scenario: Scenario) {
  return {
    id: 'cred-gcp',
    provider: 'gcp',
    connected: true,
    createdAt: '2026-11-05T10:00:30.916Z',
    gcp: {
      authType: scenario.authType ?? 'workload-identity',
      gcpProjectId: scenario.gcpProjectId ?? 'sam-byoc-test',
      serviceAccountEmail: 'sam-agent@sam-byoc-test.iam.gserviceaccount.com',
      defaultZone: 'us-central1-a',
      ...(scenario.authType === 'service-account-key' ? { privateKeyId: 'a1b2c3d4e5f6' } : {}),
      apiIssues: scenario.apiIssues ?? [],
    },
  };
}

const ROWS = accountRows({
  id: 'gcp',
  name: 'Google Cloud — BYOC test',
  kind: 'compute',
  target: 'gcp',
  isDefault: true,
});

function emptyPool() {
  return {
    effective: null,
    effectiveScope: null,
    defaults: (['project', 'user', 'installation'] as const).map((scope) => ({
      scope,
      visibility: scope === 'installation' ? 'hidden' : 'visible',
      visibilityReason: scope === 'installation' ? 'superadmin-required' : 'authenticated-user',
      canReconcile: scope !== 'installation',
      summary: null,
    })),
    precedence: ['project', 'user', 'installation'],
    reconciledScopes: ['user'],
    policyMutationSupported: true,
  };
}

function handler(scenario: Scenario) {
  return (path: string, respond: AuditResponder): Promise<void> | undefined => {
    if (path === '/api/credentials') {
      return scenario.failCredentials
        ? respond(500, { error: 'INTERNAL_ERROR', message: 'Credentials are unavailable' })
        : respond(200, [gcpCredential(scenario)]);
    }
    if (path === '/api/cc/credentials') return respond(200, { credentials: ROWS.credentials });
    if (path === '/api/cc/configurations') {
      return respond(200, { configurations: ROWS.configurations });
    }
    if (path === '/api/cc/attachments') return respond(200, { attachments: ROWS.attachments });
    if (path === '/api/credentials/resolution-status') return respond(200, { consumers: [] });
    if (path === '/api/credentials/limits') return respond(200, { credentials: [] });
    if (path.startsWith('/api/capacity-pools/defaults')) return respond(200, emptyPool());
    if (path === '/api/projects') return respond(200, { projects: [] });
    return respondToAppShellRoute(path, respond, { user: USER, projects: [] });
  };
}

async function openInfrastructure(page: Page, scenario: Scenario) {
  await page.addInitScript((userId) => {
    window.localStorage.setItem(`sam-onboarding-wizard-dismissed-${userId}`, 'true');
  }, USER.user.id);
  await setupAuditRoutes(page, handler(scenario));
  await page.goto('/settings/infrastructure');
  // Liveness: the cloud accounts section rendered, whatever the banner decides.
  await expect(page.getByRole('heading', { name: 'Cloud accounts' })).toBeVisible();
}

function surfaceTests(viewport: 'mobile' | 'desktop') {
  const shot = (page: Page, name: string) => screenshot(page, `gcp-api-issues-${name}-${viewport}`);

  test('banner, then the card: one API off, Workload Identity', async ({ page }) => {
    await openInfrastructure(page, { apiIssues: [BILLING_OFF] });
    const banner = page.getByTestId('gcp-api-issues-banner');
    await expect(banner).toContainText('sam-byoc-test');
    await expect(banner).toContainText('Cloud Billing');
    await assertNoOverflow(page);
    await shot(page, 'banner');

    await banner.getByRole('button', { name: 'Review' }).click();
    const sheet = page.getByRole('dialog');
    // Reviewing is not replacing: no "becomes your default" copy, no step counter.
    await expect(
      sheet.getByRole('heading', { name: 'Your Google Cloud connection' })
    ).toBeVisible();
    await expect(sheet).toContainText('Nothing changes unless you act below.');
    await expect(sheet).not.toContainText('becomes your');
    await expect(sheet).not.toContainText('Step 1 of 2');
    const notice = page.getByTestId('gcp-api-issues');
    await expect(notice).toBeVisible();
    await expect(notice.getByRole('link', { name: /^Enable in Google Cloud/ })).toHaveAttribute(
      'href',
      'https://console.cloud.google.com/apis/library/cloudbilling.googleapis.com?project=sam-byoc-test'
    );
    await expect(notice.getByRole('button', { name: 'Re-run Google setup' })).toBeVisible();
    await expect(notice.getByRole('button', { name: 'Check again' })).toBeVisible();
    // The notice leads the card, so it is in view without scrolling the sheet.
    await expect(notice).toBeInViewport();
    await assertNoOverflow(page);
    await shot(page, 'card-wif');
  });

  test('long project id, three issues of every kind, service-account key', async ({ page }) => {
    await openInfrastructure(page, {
      authType: 'service-account-key',
      gcpProjectId: LONG_PROJECT,
      apiIssues: [
        BILLING_OFF,
        {
          service: 'compute.googleapis.com',
          label: 'Compute Engine',
          reason: 'permission_denied',
          observedAt: '2026-11-07T22:10:31.542Z',
        },
        {
          service: 'aiplatform.googleapis.com',
          label: 'Vertex AI <script>alert("x")</script> 🚀',
          reason: 'not_enabled_by_setup',
        },
      ],
    });
    const banner = page.getByTestId('gcp-api-issues-banner');
    await expect(banner).toContainText('may be missing APIs SAM needs');
    await assertNoOverflow(page);
    await shot(page, 'banner-long');

    await banner.getByRole('button', { name: 'Review' }).click();
    const notice = page.getByTestId('gcp-api-issues');
    await expect(notice).toContainText('3 Google APIs this connection needs may be off in');
    await expect(notice).toContainText('gcloud services enable cloudbilling.googleapis.com');
    await expect(notice.getByRole('button', { name: 'Re-run Google setup' })).toHaveCount(0);
    await assertNoOverflow(page);
    await shot(page, 'card-long-service-account');
  });

  test('no issues: no banner, and the card shows no notice', async ({ page }) => {
    await openInfrastructure(page, { apiIssues: [] });
    await expect(page.getByTestId('gcp-api-issues-banner')).toHaveCount(0);
    await assertNoOverflow(page);
    await shot(page, 'none');
  });

  test('credentials fail to load: the page still renders without a banner', async ({ page }) => {
    await openInfrastructure(page, { failCredentials: true });
    await expect(page.getByTestId('gcp-api-issues-banner')).toHaveCount(0);
    await assertNoOverflow(page);
    await shot(page, 'credentials-error');
  });
}

test.describe('GCP API issues — Mobile', () => {
  surfaceTests('mobile');
});

test.describe('GCP API issues — Desktop', () => {
  test.use({ viewport: { width: 1280, height: 800 }, isMobile: false, hasTouch: false });
  surfaceTests('desktop');
});
