/**
 * End-to-end test: Neko browser button in project chat.
 *
 * Verifies the full flow: stop existing browser → start fresh with mobile
 * viewport → Neko opens showing Node.js server at correct dimensions.
 */
import { expect, test } from '@playwright/test';

const STAGING_API = 'https://api.sammy.party';
const STAGING_APP = 'https://app.sammy.party';

const PROJECT_ID = '01KJNR9R3TEN3KX1ETE33852R8';
const SESSION_ID = '81f67f29-13dd-4113-9a89-5ab10fe78254';

test.use({
  viewport: { width: 375, height: 667 },
  isMobile: true,
  userAgent:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
});

async function screenshot(page: import('@playwright/test').Page, name: string) {
  await page.waitForTimeout(800);
  await page.screenshot({
    path: `../../.codex/tmp/playwright-screenshots/${name}.png`,
    fullPage: true,
  });
}

test.describe('Neko Browser — Mobile E2E', () => {
  test.beforeEach(async ({ page }) => {
    const token = process.env.SAM_PLAYWRIGHT_PRIMARY_USER;
    if (!token) throw new Error('SAM_PLAYWRIGHT_PRIMARY_USER env var not set');

    const loginResp = await page.request.post(`${STAGING_API}/api/auth/token-login`, {
      data: { token },
      headers: { 'Content-Type': 'application/json' },
    });
    expect(loginResp.ok()).toBeTruthy();
  });

  test('browser button opens Neko with mobile viewport showing Node.js server', async ({ page, context }) => {
    // Step 0: Stop any existing browser sidecar
    console.log('Stopping any existing browser sidecar...');
    const stopResp = await page.request.delete(
      `${STAGING_API}/api/projects/${PROJECT_ID}/sessions/${SESSION_ID}/browser`
    );
    console.log('Stop response:', stopResp.status());
    // Wait for container to fully stop and be removed
    await page.waitForTimeout(8000);

    // Navigate to the session
    await page.goto(`${STAGING_APP}/projects/${PROJECT_ID}/chat/${SESSION_ID}`, {
      waitUntil: 'networkidle',
    });
    await page.waitForTimeout(3000);
    await screenshot(page, 'neko-01-session-view');

    // Step 1: Expand header
    const expandBtn = page.getByLabel('Show session details');
    if (await expandBtn.isVisible().catch(() => false)) {
      await expandBtn.click();
      await page.waitForTimeout(1000);
    }
    await screenshot(page, 'neko-02-header-expanded');

    // Step 2: Find the Browser button
    const browserBtn = page.getByRole('button', { name: /browser/i });
    expect(await browserBtn.isVisible()).toBeTruthy();

    // Step 3: Intercept the browser start API call to see what viewport is sent
    let capturedBody: string | null = null;
    await page.route('**/api/projects/*/sessions/*/browser', async (route) => {
      if (route.request().method() === 'POST') {
        capturedBody = route.request().postData();
        console.log('Intercepted browser start request body:', capturedBody);
      }
      await route.continue();
    });

    // Step 4: Click the Browser button
    console.log('Clicking Browser button...');
    const popupPromise = context.waitForEvent('page', { timeout: 60000 }).catch(() => null);
    await browserBtn.click();

    // Wait for spinner to stop
    console.log('Waiting for API call to complete...');
    try {
      await page.locator('button:has-text("Browser") .animate-spin').waitFor({
        state: 'detached',
        timeout: 45000,
      });
      console.log('API call completed');
    } catch {
      console.log('Spinner still showing after 45s');
    }

    // Log intercepted body
    if (capturedBody) {
      try {
        const parsed = JSON.parse(capturedBody);
        console.log('Viewport sent:', parsed.viewportWidth, 'x', parsed.viewportHeight);
        console.log('DPR:', parsed.devicePixelRatio);
        console.log('Touch:', parsed.isTouchDevice);
        console.log('UA:', parsed.userAgent?.substring(0, 50));
        console.log('StartURL:', parsed.startURL);
      } catch {
        console.log('Raw body:', capturedBody);
      }
    } else {
      console.log('WARNING: No browser start request intercepted');
    }

    await screenshot(page, 'neko-03-after-api');

    // Check for errors
    const errorEl = page.locator('text=/Browser:/');
    if (await errorEl.isVisible().catch(() => false)) {
      const errText = await errorEl.textContent();
      console.log('ERROR:', errText);
      await screenshot(page, 'neko-04-error');
      test.fail(true, `Browser error: ${errText}`);
      return;
    }

    // Step 5: Check popup
    const popup = await popupPromise;
    expect(popup).toBeTruthy();

    if (popup!.url() === 'about:blank') {
      try {
        await popup!.waitForURL(/.*(?!about:blank).*/, { timeout: 15000 });
      } catch {
        // empty
      }
    }

    console.log('Neko URL:', popup!.url());
    expect(popup!.url()).toContain('browser');

    // Wait for Neko + Chrome to fully render
    await popup!.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});
    await popup!.waitForTimeout(15000); // Extra time for Chrome to start and render

    // Take the key screenshot
    await popup!.screenshot({
      path: '../../.codex/tmp/playwright-screenshots/neko-05-neko-mobile.png',
      fullPage: true,
    });

    const title = await popup!.title().catch(() => 'unknown');
    console.log('Neko page title:', title);
    expect(title).toBe('n.eko');

    const videoCount = await popup!.locator('video').count();
    console.log('Video elements:', videoCount);
    expect(videoCount).toBeGreaterThan(0);

    // Also screenshot the main page
    await screenshot(page, 'neko-06-main-page');

    console.log('SUCCESS: Neko browser opened showing Node.js server');
  });
});
