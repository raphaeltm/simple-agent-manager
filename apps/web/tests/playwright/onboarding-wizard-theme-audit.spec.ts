/**
 * Theme audit for the Choose-Your-Path onboarding wizard.
 *
 * Regression target: the full-screen onboarding overlay rendered a hardcoded
 * dark green-vignette background (and a `hover:bg-white/5` X button) regardless
 * of the active theme. In light mode the page `<body>` was correctly light but
 * the overlay on top stayed dark — a jarring dark takeover for light-mode users
 * during first-run.
 *
 * The fix moves the overlay background into a theme-aware token
 * (`--sam-onboarding-overlay-bg`, defined per theme in
 * `packages/ui/src/tokens/theme.css`). This spec forces the overlay via
 * `?onboarding` in both themes, asserts the resolved background matches the
 * active theme, and captures screenshots with no horizontal overflow.
 *
 * Run with:
 *   npx playwright test onboarding-wizard-theme-audit \
 *     --project="iPhone SE (375x667)" --project="Desktop (1280x800)"
 */
import { expect, type Page, type Route, test } from '@playwright/test';

import { assertNoOverflow, jsonResponse, makeMockUser, screenshot } from './audit-helpers';

const MOCK_USER = makeMockUser({
  email: 'demo@example.com',
  name: 'Demo User',
  role: 'superadmin',
  sessionId: 'session-demo-1',
  userId: 'user-demo-1',
});

async function seedTheme(page: Page, theme: 'dark' | 'light') {
  await page.addInitScript((value) => {
    window.localStorage.setItem('sam-theme', value);
  }, theme);
}

async function setupMocks(page: Page) {
  await page.route('**/api/**', async (route: Route) => {
    const p = new URL(route.request().url()).pathname;
    const isGet = route.request().method() === 'GET';

    if (p.includes('/api/auth/')) return jsonResponse(route, 200, MOCK_USER);
    if (p === '/api/dashboard/active-tasks') return jsonResponse(route, 200, { tasks: [] });
    if (p.startsWith('/api/notifications'))
      return jsonResponse(route, 200, { notifications: [], unreadCount: 0 });
    if (p === '/api/agents') return jsonResponse(route, 200, []);
    if (p === '/api/credentials/agent' && isGet) return jsonResponse(route, 200, { credentials: [] });
    if (p === '/api/credentials' && isGet) return jsonResponse(route, 200, []);
    if (p === '/api/github/installations') return jsonResponse(route, 200, []);
    if (p === '/api/trial/status') return jsonResponse(route, 200, { available: false });
    if (p === '/api/projects' && isGet) return jsonResponse(route, 200, { projects: [] });
    if (p.startsWith('/api/workspaces')) return jsonResponse(route, 200, []);

    return jsonResponse(route, 200, {});
  });
}

for (const theme of ['dark', 'light'] as const) {
  test(`onboarding wizard renders ${theme} theme without overflow`, async ({ page }) => {
    await seedTheme(page, theme);
    await setupMocks(page);

    await page.goto('/dashboard?onboarding');

    const wizard = page.locator('[data-testid="onboarding-wizard"]');
    await expect(wizard).toBeVisible({ timeout: 3000 });

    // The theme attribute drives the token layer.
    await expect(page.locator('html')).toHaveAttribute(
      'data-ui-theme',
      theme === 'dark' ? 'sam' : 'sam-light',
    );

    // The overlay background must resolve to the theme-aware token, not a
    // hardcoded dark gradient. The token resolves to a `background-image` of two
    // radial-gradients plus a base `background-color`. The base color differs
    // per theme: ~#0a0e0a (dark) vs ~#eef3ef (light).
    const bgColor = await wizard.evaluate((el) => getComputedStyle(el).backgroundColor);
    if (theme === 'light') {
      // Light base #eef3ef → high RGB channels.
      expect(bgColor).toMatch(/rgb\(2[0-5]\d, 2[0-5]\d, 2[0-5]\d\)/);
    } else {
      // Dark base #0a0e0a → very low RGB channels.
      expect(bgColor).toMatch(/rgb\(\d{1,2}, \d{1,2}, \d{1,2}\)/);
    }

    await assertNoOverflow(page);
    await screenshot(page, `onboarding-wizard-${theme}`);
  });
}
