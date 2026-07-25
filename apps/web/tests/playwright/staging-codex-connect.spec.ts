/**
 * Staging verification for native Codex device login.
 *
 * Success means the deployed container's real Codex app-server returns a
 * trusted OpenAI verification URL and one-time code through the authenticated
 * setup-session API, and the responsive UI exposes working open/copy controls.
 */
import { expect, test } from '@playwright/test';

const STAGING_APP = 'https://app.sammy.party';
const STAGING_API = 'https://api.sammy.party';
const SCREENSHOT_DIR = '../../.codex/tmp/playwright-screenshots';
const SETUP_BASE = `${STAGING_API}/api/agent-credential-setup-sessions`;

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

test('API: real Codex app-server returns device URL and code', async ({ page }) => {
  await login(page);
  const config = await page.request.get(`${SETUP_BASE}/config`);
  expect(config.status()).toBe(200);
  expect((await config.json()).enabled).toBe(true);

  const created = await page.request.post(SETUP_BASE, {
    data: { agentType: 'openai-codex' },
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
  expect(session.verificationUrl).toMatch(/^https:\/\/([a-z0-9-]+\.)*openai\.com\//i);
  expect(session.userCode).toMatch(/^[A-Z0-9-]{4,}$/i);
  expect(session.loginCommand).toBeUndefined();

  await page.request.post(`${SETUP_BASE}/${sessionId}/cancel`).catch(() => {});
});

test('UI: desktop and mobile expose native open/copy actions without a terminal', async ({
  page,
}) => {
  await login(page);
  await page.goto(`${STAGING_APP}/settings/agents`, { waitUntil: 'networkidle' });

  const subscriptionToggle = page.getByText(/subscription|oauth|sign in with/i).first();
  if (await subscriptionToggle.count()) await subscriptionToggle.click().catch(() => {});

  const connect = page.getByRole('button', { name: /connect with codex/i }).first();
  await expect(connect).toBeVisible({ timeout: 15_000 });
  await connect.click();

  const open = page.getByRole('link', { name: /open openai sign-in/i });
  const copy = page.getByRole('button', { name: /copy code/i });
  await expect(open).toBeVisible({ timeout: 120_000 });
  await expect(copy).toBeVisible();
  await expect(open).toHaveAttribute('href', /^https:\/\/([a-z0-9-]+\.)*openai\.com\//i);
  await expect(page.getByTestId('codex-terminal')).toHaveCount(0);

  await page.screenshot({
    path: `${SCREENSHOT_DIR}/codex-connect-modal-desktop.png`,
    fullPage: true,
  });
  await page.setViewportSize({ width: 375, height: 667 });
  await expect(open).toBeVisible();
  await expect(copy).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true
  );
  await page.screenshot({
    path: `${SCREENSHOT_DIR}/codex-connect-modal-mobile.png`,
    fullPage: true,
  });

  await copy.click();
  await expect(page.getByRole('button', { name: /copied/i })).toBeVisible();
  await page
    .getByRole('button', { name: /^cancel$/i })
    .click()
    .catch(() => {});
});
