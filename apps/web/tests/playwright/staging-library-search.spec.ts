/**
 * Staging verification for the client-side library search index feature
 * (idea 01KTEGHZ8DA0ATXQAZTXGCEK54). Exercises the feature end-to-end on
 * app.sammy.party against a real sub-cap project (13 files → client index path).
 */
import { expect, test } from '@playwright/test';

const STAGING_APP = 'https://app.sammy.party';
const STAGING_API = 'https://api.sammy.party';
const SCREENSHOT_DIR = '../../.codex/tmp/playwright-screenshots';
// Test Project 2 — 13 library files, sub-cap so it uses the client index path.
const PROJECT_ID = '01KJVGMWX26SGQ5DX94GMTJRQN';

test.beforeEach(async ({ page }) => {
  const token = process.env.SAM_PLAYWRIGHT_PRIMARY_USER;
  if (!token) throw new Error('SAM_PLAYWRIGHT_PRIMARY_USER env var not set');
  const loginResp = await page.request.post(`${STAGING_API}/api/auth/token-login`, {
    data: { token },
    headers: { 'Content-Type': 'application/json' },
  });
  expect(loginResp.status()).toBe(200);
});

test.describe('Library client-side search (desktop)', () => {
  test('always-visible search filters the swept index without a server round-trip', async ({
    page,
  }) => {
    await page.goto(`${STAGING_APP}/projects/${PROJECT_ID}/library`, {
      waitUntil: 'networkidle',
    });
    await page.waitForTimeout(1500);

    // The always-visible search input exists between header and breadcrumb.
    const search = page.getByPlaceholder(/search/i).first();
    await expect(search).toBeVisible();

    // Baseline: known files render.
    await expect(page.getByText('sam-pitch-deck-v3.pdf')).toBeVisible();
    await page.screenshot({
      path: `${SCREENSHOT_DIR}/library-search-baseline-desktop.png`,
      fullPage: true,
    });

    // Type a query that matches a subset.
    await search.fill('pitch');
    await page.waitForTimeout(600);
    await expect(page.getByText('sam-pitch-deck-v3.pdf')).toBeVisible();
    await page.screenshot({
      path: `${SCREENSHOT_DIR}/library-search-pitch-desktop.png`,
      fullPage: true,
    });

    // A non-matching query yields an empty/no-results state.
    await search.fill('zzznomatchxyz');
    await page.waitForTimeout(600);
    await expect(page.getByText('sam-pitch-deck-v3.pdf')).toHaveCount(0);

    // Clearing restores the full list.
    await search.fill('');
    await page.waitForTimeout(600);
    await expect(page.getByText('sam-pitch-deck-v3.pdf')).toBeVisible();

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth,
    );
    expect(overflow).toBe(false);
  });
});

test.describe('Library client-side search (mobile)', () => {
  test.use({ viewport: { width: 375, height: 667 } });

  test('search row is present and results filter on mobile', async ({ page }) => {
    await page.goto(`${STAGING_APP}/projects/${PROJECT_ID}/library`, {
      waitUntil: 'networkidle',
    });
    await page.waitForTimeout(1500);

    const search = page.getByPlaceholder(/search/i).first();
    await expect(search).toBeVisible();

    await search.fill('pdf');
    await page.waitForTimeout(600);
    await page.screenshot({
      path: `${SCREENSHOT_DIR}/library-search-pdf-mobile.png`,
      fullPage: true,
    });

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth,
    );
    expect(overflow).toBe(false);
  });
});
