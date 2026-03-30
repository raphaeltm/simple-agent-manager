import { test, expect } from '@playwright/test';
import { loginWithToken } from './helpers/auth';

const APP_URL = process.env.SMOKE_TEST_URL || 'https://app.sammy.party';

test.describe('Navigation', () => {
  test('can navigate to projects page', async ({ context }) => {
    const page = await loginWithToken(context);
    await page.goto(`${APP_URL}/projects`);
    await page.waitForLoadState('networkidle');

    const body = await page.textContent('body');
    expect(body).toBeTruthy();
    // Should not show an error page
    expect(body).not.toContain('500');
  });

  test('can navigate to settings page', async ({ context }) => {
    const page = await loginWithToken(context);
    await page.goto(`${APP_URL}/settings/cloud-provider`);
    await page.waitForLoadState('networkidle');

    const body = await page.textContent('body');
    expect(body).toContain('Settings');
  });

  test('unauthenticated access redirects to login', async ({ page }) => {
    // Without token auth, visiting a protected page should redirect
    await page.goto(`${APP_URL}/dashboard`);
    await page.waitForLoadState('networkidle');

    // Should either show a login page or redirect to one
    const url = page.url();
    const body = await page.textContent('body');
    // Either we're on a login page or we see a sign-in prompt
    const isLoginPage = url.includes('sign-in') || url.includes('login');
    const hasSignIn = body?.includes('Sign in') || body?.includes('GitHub');
    expect(isLoginPage || hasSignIn).toBe(true);
  });
});
