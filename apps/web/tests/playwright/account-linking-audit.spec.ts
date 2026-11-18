import { expect, type Page, type Route, test } from '@playwright/test';

import {
  assertNoClippedOverflow,
  assertNoOverflow,
  jsonResponse,
  makeMockUser,
  screenshot as takeScreenshot,
} from './audit-helpers';

async function screenshot(page: Page, name: string) {
  if (!name.includes('banner')) {
    const target = page.getByTestId(
      name.startsWith('github-app') ? 'github-app-section' : 'connected-accounts'
    );
    await target.evaluate((el) => el.scrollIntoView({ block: 'start' }));
  }
  await takeScreenshot(page, name);
}

const USER = makeMockUser({
  email: 'email@example.com',
  name: 'Email User',
  sessionId: 'link-session',
  userId: 'link-user',
  role: 'superadmin',
});
interface Scenario {
  connected?: boolean;
  readError?: boolean;
  requestError?: boolean;
  freshError?: boolean;
  appNotConfigured?: boolean;
  providerError?: boolean;
  installations?: number;
  long?: boolean;
}
async function setup(page: Page, scenario: Scenario = {}) {
  await page.addInitScript(() =>
    localStorage.setItem('sam-onboarding-wizard-dismissed-link-user', 'true')
  );
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  let connected = scenario.connected ?? false;
  await page.route(new RegExp('^https?://[^/]+/api/'), async (route: Route) => {
    const path = new URL(route.request().url()).pathname;
    const body = route.request().method() === 'POST' ? route.request().postDataJSON() : undefined;
    if (body) calls.push({ path, body });
    const reply = (status: number, data: unknown) => jsonResponse(route, status, data);
    if (path.endsWith('/list-accounts'))
      return scenario.readError
        ? reply(503, { message: 'Account lookup unavailable' })
        : reply(
            200,
            connected
              ? [
                  {
                    id: 'account-github',
                    providerId: 'github',
                    accountId: 'github-123',
                    userId: USER.user.id,
                    createdAt: '2026-01-01',
                    updatedAt: '2026-01-01',
                  },
                ]
              : []
          );
    if (path.endsWith('/unlink-account')) {
      if (scenario.freshError)
        return reply(403, { code: 'SESSION_NOT_FRESH', message: 'Session is not fresh' });
      connected = false;
      return reply(200, { status: true });
    }
    if (path.endsWith('/account-link/request'))
      return scenario.requestError
        ? reply(503, { message: 'Email delivery is temporarily unavailable. Try again.' })
        : reply(200, { sent: true });
    if (path.endsWith('/link-social'))
      return reply(400, { message: 'Confirmation expired. Request a new email.', code: 'EXPIRED' });
    if (path.includes('/api/auth/')) return reply(200, USER);
    if (path === '/api/config/login-providers')
      return reply(200, { github: true, gitlab: true, google: true, email: true });
    if (path.startsWith('/api/notifications'))
      return reply(200, { notifications: [], unreadCount: 0 });
    if (path === '/api/github/install-url' && scenario.appNotConfigured)
      return reply(409, {
        error: 'GITHUB_APP_NOT_CONFIGURED',
        message: 'An administrator must configure the GitHub App.',
      });
    if (path === '/api/github/install-url')
      return reply(200, { url: 'https://github.com/apps/test/installations/new' });
    if (path === '/api/github/installations' && scenario.providerError)
      return reply(503, {
        error: 'GITHUB_UNAVAILABLE',
        message: 'GitHub is temporarily unavailable. Try again later.',
      });
    if (path === '/api/github/installations')
      return connected
        ? reply(
            200,
            Array.from({ length: scenario.installations ?? 0 }, (_, i) => ({
              id: `inst-${i}`,
              installationId: `${i}`,
              accountName: scenario.long
                ? `${'organization'.repeat(25)}<script>🌱https://example.com/${'x'.repeat(200)}`
                : i === 0
                  ? 'A'
                  : `Team ${i}`,
              accountType: 'organization',
              createdAt: '2026-11-17',
            }))
          )
        : reply(403, { error: 'GITHUB_NOT_CONNECTED', message: 'Connect GitHub to continue.' });
    if (path === '/api/github/repositories') return reply(200, { repositories: [] });
    if (path === '/api/projects') return reply(200, { projects: [] });
    if (path.startsWith('/api/workspaces') || path === '/api/agents' || path === '/api/credentials')
      return reply(200, []);
    return reply(200, {});
  });
  return calls;
}
for (const theme of ['dark', 'light'] as const) {
  test.describe(`Account linking ${theme}`, () => {
    test.beforeEach(async ({ page }) => {
      await page.addInitScript((value) => localStorage.setItem('sam-theme', value), theme);
    });
    test('email-only account requests fresh confirmation and has no Google link control', async ({
      page,
    }) => {
      const calls = await setup(page);
      await page.goto('/settings/github');
      await expect(page.getByTestId('connected-provider-github')).toContainText('Not connected');
      await page.getByRole('button', { name: 'Connect GitHub', exact: true }).click();
      await expect(page.getByText('Check your account email', { exact: false })).toBeVisible();
      expect(
        calls.filter((c) => c.path.endsWith('/account-link/request')).map((c) => c.body)
      ).toEqual([{ provider: 'github' }]);
      expect(calls.some((c) => c.path.endsWith('/link-social'))).toBe(false);
      await expect(page.getByRole('button', { name: 'Connect Google' })).toHaveCount(0);
      await screenshot(page, `connected-accounts-email-${theme}`);
      await assertNoOverflow(page);
      await assertNoClippedOverflow(page);
    });
    test('email fragment is removed before explicit confirmation and expired proof can be retried', async ({
      page,
    }) => {
      const calls = await setup(page);
      await page.goto('/settings/github#provider=github&linkToken=one-time-browser-proof');
      const confirm = page.getByRole('button', { name: 'Confirm connection to GitHub' });
      await expect(confirm).toBeVisible();
      expect(new URL(page.url()).hash).toBe('');
      expect(calls.some((c) => c.path.endsWith('/link-social'))).toBe(false);
      await screenshot(page, `connected-accounts-confirm-${theme}`);
      await assertNoOverflow(page);
      await assertNoClippedOverflow(page);
      await confirm.click();
      await expect(page.getByText('Confirmation expired. Request a new email.')).toBeVisible();
      expect(calls.find((c) => c.path.endsWith('/link-social'))?.body.additionalData).toEqual({
        samLinkToken: 'one-time-browser-proof',
      });
      await page.getByRole('button', { name: 'Connect GitHub', exact: true }).click();
      await expect(page.getByText('Check your account email', { exact: false })).toBeVisible();
      await screenshot(page, `connected-accounts-expired-${theme}`);
    });
    test('disconnect updates the existing provider row', async ({ page }) => {
      const calls = await setup(page, { connected: true });
      await page.goto('/settings/github');
      const row = page.getByTestId('connected-provider-github');
      await row.getByRole('button', { name: 'Disconnect GitHub' }).click();
      await expect(row).toContainText('Not connected');
      await expect(row.getByRole('button', { name: 'Connect GitHub' })).toBeVisible();
      expect(calls.find((c) => c.path.endsWith('/unlink-account'))?.body).toEqual({
        accountId: 'account-github',
      });
      await screenshot(page, `connected-accounts-disconnected-${theme}`);
      await assertNoOverflow(page);
      await assertNoClippedOverflow(page);
    });
    test('disconnect freshness refusal provides sign-in recovery', async ({ page }) => {
      await setup(page, { connected: true, freshError: true });
      await page.goto('/settings/github');
      await page.getByRole('button', { name: 'Disconnect GitHub' }).click();
      await expect(
        page.getByText('Sign out and sign in again before disconnecting this account.')
      ).toBeVisible();
      await expect(page.getByRole('button', { name: 'Sign out to verify again' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Disconnect GitHub' })).toBeEnabled();
      await screenshot(page, `connected-accounts-unlink-freshness-${theme}`);
      await assertNoOverflow(page);
      await assertNoClippedOverflow(page);
    });
    test('read failure preserves unknown status with recovery; send failure is visible', async ({
      page,
    }) => {
      await setup(page, { readError: true });
      await page.goto('/settings/github');
      await expect(
        page.getByText('Could not read your connected accounts.', { exact: false })
      ).toBeVisible({ timeout: 15000 });
      await expect(page.getByTestId('connected-provider-github')).toContainText(
        'Status unavailable'
      );
      await expect(
        page.getByRole('button', { name: 'Connect GitHub', exact: true })
      ).toBeDisabled();
      await screenshot(page, `connected-accounts-read-error-${theme}`);
      await assertNoOverflow(page);
      await assertNoClippedOverflow(page);
      await page.unroute(new RegExp('^https?://[^/]+/api/'));
      await setup(page, { requestError: true });
      await page.reload();
      await page.getByRole('button', { name: 'Connect GitHub', exact: true }).click();
      await expect(
        page.getByText('Email delivery is temporarily unavailable. Try again.')
      ).toBeVisible();
      await screenshot(page, `connected-accounts-send-error-${theme}`);
      await assertNoOverflow(page);
      await assertNoClippedOverflow(page);
    });
    test('empty, unconfigured and unavailable GitHub App states retain the correct recovery', async ({
      page,
    }) => {
      await setup(page, { connected: true });
      await page.goto('/settings/github');
      await expect(
        page.getByRole('button', { name: 'Install GitHub App', exact: true })
      ).toBeEnabled();
      await screenshot(page, `github-app-empty-${theme}`);
      await assertNoOverflow(page);
      await assertNoClippedOverflow(page);
      await page.unroute(new RegExp('^https?://[^/]+/api/'));
      await setup(page, { connected: true, appNotConfigured: true });
      await page.reload();
      await expect(page.getByText('An administrator must configure the GitHub App.')).toBeVisible();
      await expect(
        page.getByRole('button', { name: 'Install GitHub App', exact: true })
      ).toBeDisabled();
      await screenshot(page, `github-app-unconfigured-${theme}`);
      await assertNoOverflow(page);
      await assertNoClippedOverflow(page);
      await page.unroute(new RegExp('^https?://[^/]+/api/'));
      await setup(page, { connected: true, providerError: true });
      await page.reload();
      await expect(
        page.getByText('GitHub is temporarily unavailable. Try again later.')
      ).toBeVisible();
      await expect(page.getByRole('button', { name: 'Sign out and reconnect' })).toHaveCount(0);
      await page
        .getByText('GitHub is temporarily unavailable. Try again later.')
        .scrollIntoViewIfNeeded();
      await takeScreenshot(page, `github-app-unavailable-${theme}`);
      await assertNoOverflow(page);
      await assertNoClippedOverflow(page);
    });
    test('GitHub installations wrap long unbroken names, URLs and special characters across many rows', async ({
      page,
    }) => {
      await setup(page, { connected: true, installations: 30, long: true });
      await page.goto('/settings/github');
      await expect(page.getByText('30 accounts', { exact: false })).toBeVisible();
      await screenshot(page, `github-app-many-long-${theme}`);
      await assertNoOverflow(page);
      await assertNoClippedOverflow(page);
    });
    test('missing link banner navigates to Settings; expired authorization has separate recovery', async ({
      page,
    }) => {
      await setup(page);
      await page.goto('/projects');
      await expect(page.getByRole('heading', { name: 'Projects', exact: true })).toBeVisible();
      await page.evaluate(() =>
        window.dispatchEvent(
          new CustomEvent('sam:github-reauth-required', {
            detail: {
              code: 'GITHUB_NOT_CONNECTED',
              message: 'Connect GitHub to work on this project.',
            },
          })
        )
      );
      await expect(page.getByText('Connect GitHub to continue', { exact: true })).toBeVisible();
      await screenshot(page, `github-connect-banner-${theme}`);
      await assertNoOverflow(page);
      await assertNoClippedOverflow(page);
      await page.getByRole('button', { name: 'Connect GitHub', exact: true }).click();
      await expect(page).toHaveURL(/settings\/github/);
      await expect(page.getByTestId('connected-provider-github')).toBeVisible();
      await page.evaluate(() =>
        window.dispatchEvent(
          new CustomEvent('sam:github-reauth-required', {
            detail: {
              code: 'GITHUB_REAUTH_REQUIRED',
              message: 'Your GitHub authorization expired.',
            },
          })
        )
      );
      await expect(page.getByText('GitHub sign-in required', { exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Sign out and reconnect' })).toBeVisible();
      await screenshot(page, `github-reauth-banner-${theme}`);
      await assertNoOverflow(page);
      await assertNoClippedOverflow(page);
    });
  });
}
