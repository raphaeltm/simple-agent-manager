import { test, expect } from '@playwright/test';
import { loginWithToken } from './helpers/auth';

test.describe('Settings', () => {
  test('settings page loads with tabs', async ({ context }) => {
    const page = await loginWithToken(context);
    await page.goto(`${process.env.SMOKE_TEST_URL || 'https://app.sammy.party'}/settings/cloud-provider`);
    await page.waitForLoadState('networkidle');

    // Settings page should show tab navigation
    const pageText = await page.textContent('body');
    expect(pageText).toContain('Settings');
  });

  test('smoke test tokens tab is visible when enabled', async ({ context }) => {
    const page = await loginWithToken(context);
    await page.goto(
      `${process.env.SMOKE_TEST_URL || 'https://app.sammy.party'}/settings/smoke-test-tokens`
    );
    await page.waitForLoadState('networkidle');

    // Should show the smoke test tokens section
    const pageText = await page.textContent('body');
    expect(pageText).toContain('Smoke Test Auth Tokens');
  });

  test('can navigate between settings tabs', async ({ context }) => {
    const page = await loginWithToken(context);
    const appUrl = process.env.SMOKE_TEST_URL || 'https://app.sammy.party';

    await page.goto(`${appUrl}/settings/cloud-provider`);
    await page.waitForLoadState('networkidle');

    // Navigate to agent keys tab
    const agentKeysLink = page.locator('a', { hasText: 'Agent Keys' });
    if (await agentKeysLink.isVisible()) {
      await agentKeysLink.click();
      await page.waitForURL(/agent-keys/);
    }
  });
});
