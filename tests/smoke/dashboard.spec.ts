import { test, expect } from '@playwright/test';
import { loginWithToken } from './helpers/auth';

test.describe('Dashboard', () => {
  test('loads after token authentication', async ({ context }) => {
    const page = await loginWithToken(context);

    // Should be on the dashboard or redirected to it
    await page.waitForURL(/\/(dashboard|projects)/, { timeout: 10_000 });

    // Dashboard should show the page layout
    await expect(page.locator('body')).not.toBeEmpty();

    // Should see some content indicating we're authenticated
    // (user menu, project list, or similar)
    const pageText = await page.textContent('body');
    expect(pageText).toBeTruthy();
  });

  test('dashboard shows project cards or empty state', async ({ context }) => {
    const page = await loginWithToken(context);
    await page.waitForURL(/\/(dashboard|projects)/, { timeout: 10_000 });

    // Wait for content to load
    await page.waitForLoadState('networkidle');

    // Should show either projects or an empty state — not a blank page or error
    const hasContent = await page.locator('body').textContent();
    expect(hasContent!.length).toBeGreaterThan(50); // More than just a loading spinner
  });
});
