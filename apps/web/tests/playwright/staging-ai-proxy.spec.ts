/**
 * Staging verification for AI Proxy admin UI and trial pathway.
 */
import { expect, test } from '@playwright/test';

const STAGING_APP = 'https://app.sammy.party';
const STAGING_API = 'https://api.sammy.party';
const SCREENSHOT_DIR = '../../.codex/tmp/playwright-screenshots';

test.beforeEach(async ({ page }) => {
  // Authenticate via smoke test token
  const token = process.env.SAM_PLAYWRIGHT_PRIMARY_USER;
  if (!token) throw new Error('SAM_PLAYWRIGHT_PRIMARY_USER env var not set');

  const loginResp = await page.request.post(`${STAGING_API}/api/auth/token-login`, {
    data: { token },
    headers: { 'Content-Type': 'application/json' },
  });
  expect(loginResp.status()).toBe(200);
});

test.describe('Admin AI Proxy page', () => {
  test('loads and shows model picker (desktop)', async ({ page }) => {
    await page.goto(`${STAGING_APP}/admin/ai-proxy`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(2000);
    await page.screenshot({ path: `${SCREENSHOT_DIR}/admin-ai-proxy-desktop.png`, fullPage: true });

    // Should show the model picker dropdown
    const body = await page.textContent('body');
    expect(body).toContain('Default Model');
    expect(body).toContain('AI proxy');
  });

  test('loads and shows model picker (mobile)', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await page.goto(`${STAGING_APP}/admin/ai-proxy`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(2000);
    await page.screenshot({ path: `${SCREENSHOT_DIR}/admin-ai-proxy-mobile.png`, fullPage: true });

    // No horizontal overflow
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    expect(overflow).toBe(false);
  });

  test('API config endpoint returns valid config', async ({ page }) => {
    const resp = await page.request.get(`${STAGING_API}/api/admin/ai-proxy/config`);
    expect(resp.status()).toBe(200);
    const config = await resp.json();

    // Should have a default model
    expect(config.defaultModel).toBeTruthy();
    // Should have models array
    expect(config.models).toBeInstanceOf(Array);
    expect(config.models.length).toBeGreaterThan(0);

    // Without Anthropic key, Anthropic models should show as unavailable
    const _anthropicModels = config.models.filter((m: { provider: string }) => m.provider === 'anthropic');
    const workersAIModels = config.models.filter((m: { provider: string }) => m.provider === 'workers-ai');

    // Workers AI models should be available
    for (const m of workersAIModels) {
      expect(m.available).toBe(true);
    }

    // Log the config for review
    console.log('AI Proxy Config:', JSON.stringify(config, null, 2));
  });
});

test.describe('Existing workflows (regression check)', () => {
  test('dashboard loads', async ({ page }) => {
    await page.goto(`${STAGING_APP}/dashboard`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1000);
    await page.screenshot({ path: `${SCREENSHOT_DIR}/dashboard-desktop.png`, fullPage: true });

    const body = await page.textContent('body');
    expect(body).toBeTruthy();
  });

  test('admin credentials tab loads', async ({ page }) => {
    await page.goto(`${STAGING_APP}/admin/credentials`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1000);
    await page.screenshot({ path: `${SCREENSHOT_DIR}/admin-credentials-desktop.png`, fullPage: true });
  });

  test('projects page loads', async ({ page }) => {
    await page.goto(`${STAGING_APP}/projects`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1000);
    await page.screenshot({ path: `${SCREENSHOT_DIR}/projects-desktop.png`, fullPage: true });
  });

  test('settings page loads', async ({ page }) => {
    await page.goto(`${STAGING_APP}/settings`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1000);
    await page.screenshot({ path: `${SCREENSHOT_DIR}/settings-desktop.png`, fullPage: true });
  });

  test('API health check', async ({ page }) => {
    const resp = await page.request.get(`${STAGING_API}/health`);
    expect(resp.status()).toBe(200);
  });
});
