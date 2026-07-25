/**
 * Staging verification for native Claude Code OAuth login.
 *
 * Success means the deployed container's real Claude Code setup-token flow
 * returns a trusted Claude/Anthropic auth URL through the authenticated
 * setup-session API, and the responsive UI exposes a native link without any
 * terminal surface. Completing the external Claude OAuth flow is intentionally
 * out of scope for this smoke test.
 */
import { expect, test } from '@playwright/test';

const STAGING_APP = 'https://app.sammy.party';
const STAGING_API = 'https://api.sammy.party';
const SCREENSHOT_DIR = '../../.codex/tmp/playwright-screenshots';
const SETUP_BASE = `${STAGING_API}/api/agent-credential-setup-sessions`;
const TRUSTED_CLAUDE_AUTH_URL =
  /^https:\/\/([a-z0-9-]+\.)*(claude\.ai|anthropic\.com)\//i;

test.setTimeout(180_000);

async function login(page: import('@playwright/test').Page): Promise<void> {
  const token = process.env.SAM_PLAYWRIGHT_PRIMARY_USER;
  if (!token) throw new Error('SAM_PLAYWRIGHT_PRIMARY_USER env var not set');
  const response = await page.request.post(`${STAGING_API}/api/auth/token-login`, {
    data: { token },
    headers: { 'Content-Type': 'application/json' },
  });
  expect(response.status()).toBe(200);
}

test.describe.configure({ mode: 'serial' });

test('API: real Claude Code setup-token flow returns trusted auth URL', async ({
  page,
}) => {
  await login(page);
  const config = await page.request.get(`${SETUP_BASE}/config`);
  expect(config.status()).toBe(200);
  const configBody = await config.json();
  expect(configBody.enabled).toBe(true);
  expect(configBody.agentTypes).toContain('claude-code');

  const created = await page.request.post(SETUP_BASE, {
    data: { agentType: 'claude-code' },
    headers: { 'Content-Type': 'application/json' },
  });
  expect(created.status()).toBe(201);
  const initial = await created.json();
  const sessionId: string = initial.id;

  let session = initial;
  const deadline = Date.now() + 120_000;
  while (session.status !== 'waiting_for_user' && Date.now() < deadline) {
    expect(['failed', 'expired', 'cancelled']).not.toContain(session.status);
    await page.waitForTimeout(2500);
    const poll = await page.request.get(`${SETUP_BASE}/${sessionId}`);
    expect(poll.status()).toBe(200);
    session = await poll.json();
  }

  expect(session.status).toBe('waiting_for_user');
  expect(session.verificationUrl).toMatch(TRUSTED_CLAUDE_AUTH_URL);
  expect(session.userCode ?? null).toBeNull();
  expect(session.loginCommand).toBeUndefined();

  await page.request.post(`${SETUP_BASE}/${sessionId}/cancel`).catch(() => {});
});

test('UI: Claude Code exposes native auth link without a terminal', async ({
  page,
}) => {
  await login(page);
  await page.goto(`${STAGING_APP}/settings/agents`, { waitUntil: 'networkidle' });

  const oauthTab = page.getByText(/subscription|oauth|sign in with/i).first();
  if (await oauthTab.count()) await oauthTab.click().catch(() => {});

  const connect = page.getByRole('button', { name: /connect with claude code/i }).first();
  await expect(connect).toBeVisible({ timeout: 15_000 });
  await connect.click();

  const open = page.getByRole('link', { name: /open claude sign-in/i });
  await expect(open).toBeVisible({ timeout: 120_000 });
  await expect(open).toHaveAttribute('href', TRUSTED_CLAUDE_AUTH_URL);
  await expect(page.getByTestId('codex-terminal')).toHaveCount(0);
  await expect(page.locator('pre')).toHaveCount(0);

  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
  ).toBe(true);

  const [signInPage] = await Promise.all([page.context().waitForEvent('page'), open.click()]);
  await signInPage.waitForLoadState('domcontentloaded');
  expect(new URL(signInPage.url()).hostname).toMatch(/(^|\.)claude\.ai$|(^|\.)anthropic\.com$/i);
  await signInPage.close();

  await page.screenshot({
    path: `${SCREENSHOT_DIR}/claude-connect-modal-staging-desktop.png`,
    fullPage: true,
  });

  await page
    .getByRole('button', { name: /^cancel$/i })
    .click()
    .catch(() => {});
});
