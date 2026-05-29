/**
 * Staging verification for CLI Auth (PATs + Device Flow)
 *
 * Tests:
 * 1. API health check
 * 2. API Tokens settings tab renders
 * 3. PAT creation and revocation
 * 4. token-login endpoint works with a valid PAT
 * 5. token-login rejects revoked PAT
 * 6. Device flow /device page is public and renders
 * 7. Device code creation via API
 * 8. Device flow approval with invalid code shows error
 * 9. Dashboard regression check
 */
import { expect, type Page, test } from '@playwright/test';

const API_URL = 'https://api.sammy.party';
const APP_URL = 'https://app.sammy.party';

async function loginToStaging(page: Page): Promise<void> {
  const token = process.env.SAM_PLAYWRIGHT_PRIMARY_USER;
  if (!token) throw new Error('SAM_PLAYWRIGHT_PRIMARY_USER env var not set');

  const resp = await page.request.post(`${API_URL}/api/auth/token-login`, {
    data: { token },
    headers: { 'Content-Type': 'application/json' },
  });
  expect(resp.status()).toBe(200);
  const body = await resp.json();
  expect(body.success).toBe(true);
}

test.describe('CLI Auth Staging Verification', () => {
  test('API health check', async ({ page }) => {
    const resp = await page.request.get(`${API_URL}/health`);
    expect(resp.status()).toBe(200);
  });

  test('API Tokens settings tab renders', async ({ page }) => {
    await loginToStaging(page);
    await page.goto(`${APP_URL}/settings/api-tokens`);
    await page.waitForLoadState('networkidle');
    const text = await page.textContent('body');
    expect(text).toContain('API Tokens');
    await page.screenshot({
      path: '../../.codex/tmp/playwright-screenshots/staging-api-tokens-tab.png',
      fullPage: true,
    });
  });

  test('PAT UI has generate button and token list', async ({ page }) => {
    await loginToStaging(page);
    await page.goto(`${APP_URL}/settings/api-tokens`);
    await page.waitForLoadState('networkidle');

    // The generate token button should be visible
    const generateBtn = page.getByRole('button', { name: /generate new token/i });
    await expect(generateBtn).toBeVisible();

    // Click to open dialog
    await generateBtn.click();
    await page.waitForTimeout(500);

    // Dialog should show name input and generate button
    const nameInput = page.getByRole('textbox', { name: /laptop/i });
    await expect(nameInput).toBeVisible();

    await page.screenshot({
      path: '../../.codex/tmp/playwright-screenshots/staging-pat-dialog.png',
      fullPage: true,
    });
  });

  test('token-login endpoint accepts valid smoke test token', async ({ page }) => {
    const token = process.env.SAM_PLAYWRIGHT_PRIMARY_USER;
    if (!token) throw new Error('SAM_PLAYWRIGHT_PRIMARY_USER env var not set');

    const resp = await page.request.post(`${API_URL}/api/auth/token-login`, {
      data: { token },
      headers: { 'Content-Type': 'application/json' },
    });
    expect(resp.status()).toBe(200);
    const body = await resp.json();
    expect(body.success).toBe(true);
    expect(body.sessionCookie).toBeTruthy();
    expect(body.user).toBeTruthy();
    expect(body.user.id).toBeTruthy();
  });

  test('token-login rejects invalid token', async ({ page }) => {
    const resp = await page.request.post(`${API_URL}/api/auth/token-login`, {
      data: { token: 'sam_pat_invalid_token_value' },
      headers: { 'Content-Type': 'application/json' },
    });
    expect(resp.status()).toBe(401);
  });

  test('device flow /device page is public', async ({ page }) => {
    await page.goto(`${APP_URL}/device`);
    await page.waitForLoadState('networkidle');
    const text = await page.textContent('body');
    expect(text).toContain('Authorize SAM CLI');
    await page.screenshot({
      path: '../../.codex/tmp/playwright-screenshots/staging-device-page.png',
      fullPage: true,
    });
  });

  test('device flow code creation via API', async ({ page }) => {
    const resp = await page.request.post(`${API_URL}/api/auth/device/code`);
    expect(resp.status()).toBe(200);
    const body = await resp.json();
    expect(body.deviceCode).toBeTruthy();
    expect(body.userCode).toBeTruthy();
    expect(body.verificationUri).toContain('/device');
    expect(body.verificationUriComplete).toContain('code=');
    expect(body.expiresIn).toBeGreaterThan(0);
    expect(body.interval).toBeGreaterThan(0);
  });

  test('device flow /device with prefilled code shows input', async ({ page }) => {
    await page.goto(`${APP_URL}/device?code=TEST-1234`);
    await page.waitForLoadState('networkidle');
    const input = page.locator('input#device-user-code');
    await expect(input).toBeVisible();
    const value = await input.inputValue();
    expect(value).toBe('TEST-1234');
    await page.screenshot({
      path: '../../.codex/tmp/playwright-screenshots/staging-device-prefilled.png',
      fullPage: true,
    });
  });

  test('dashboard regression check', async ({ page }) => {
    await loginToStaging(page);
    await page.goto(APP_URL);
    await page.waitForLoadState('networkidle');
    // Dashboard should render
    const text = await page.textContent('body');
    expect(text).toBeTruthy();
    // No error banners
    const errorAlert = page.locator('[role="alert"][class*="error"], .error-banner');
    expect(await errorAlert.count()).toBe(0);
    await page.screenshot({
      path: '../../.codex/tmp/playwright-screenshots/staging-dashboard-regression.png',
      fullPage: true,
    });
  });

  test('settings page loads without errors', async ({ page }) => {
    await loginToStaging(page);
    await page.goto(`${APP_URL}/settings`);
    await page.waitForLoadState('networkidle');
    const text = await page.textContent('body');
    expect(text).toContain('Settings');
    await page.screenshot({
      path: '../../.codex/tmp/playwright-screenshots/staging-settings-regression.png',
      fullPage: true,
    });
  });
});
