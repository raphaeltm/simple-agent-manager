/**
 * Visual audit for the instant-render onboarding overlay fix.
 *
 * Regression target: the overlay used to be gated on the async credential
 * status fetch (`listCredentials` / `listGitHubInstallations` /
 * `listAgentCredentials`). `listGitHubInstallations` is slow (~5-6s), so the
 * overlay appeared "out of nowhere" several seconds after the dashboard
 * painted. The fix decouples overlay visibility from that fetch when forced via
 * `?onboarding`.
 *
 * This spec mocks the status fetch to HANG and asserts the overlay still
 * appears almost immediately, then captures screenshots at mobile + desktop and
 * asserts there is no horizontal overflow.
 *
 * Run with:
 *   npx playwright test onboarding-overlay-instant-render \
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

/**
 * Mock the API so the dashboard renders, but make the three credential-status
 * endpoints HANG forever. This simulates the slow `GET /api/github/installations`
 * that previously delayed the overlay. If the overlay still appears, it is no
 * longer gated on these calls.
 */
async function setupSlowStatusMocks(page: Page) {
  await page.route('**/api/**', async (route: Route) => {
    const p = new URL(route.request().url()).pathname;
    const isGet = route.request().method() === 'GET';

    if (p.includes('/api/auth/')) return jsonResponse(route, 200, MOCK_USER);

    // The three credential-status endpoints the overlay used to wait on — hang.
    if (p === '/api/github/installations') return; // never fulfilled
    if (p === '/api/credentials' && isGet) return; // hang
    if (p === '/api/credentials/agent' && isGet) return; // hang

    // Dashboard data — respond so the shell paints normally.
    if (p === '/api/dashboard/active-tasks') return jsonResponse(route, 200, { tasks: [] });
    if (p.startsWith('/api/notifications'))
      return jsonResponse(route, 200, { notifications: [], unreadCount: 0 });
    if (p === '/api/agents') return jsonResponse(route, 200, []);
    if (p === '/api/trial-status') return jsonResponse(route, 200, { available: false });
    if (p === '/api/projects' && isGet) return jsonResponse(route, 200, { projects: [] });
    if (p.startsWith('/api/workspaces')) return jsonResponse(route, 200, []);

    return jsonResponse(route, 200, {});
  });
}

test('?onboarding overlay renders instantly despite a hung status fetch', async ({ page }) => {
  await setupSlowStatusMocks(page);

  await page.goto('/dashboard?onboarding');

  // The overlay must appear well within the old ~5-6s window. 3s is a generous
  // ceiling that still proves the fetch (which never resolves) does not gate it.
  const wizard = page.locator('[data-testid="onboarding-wizard"]');
  await expect(wizard).toBeVisible({ timeout: 3000 });

  await assertNoOverflow(page);

  await screenshot(page, 'onboarding-overlay-instant');
});
