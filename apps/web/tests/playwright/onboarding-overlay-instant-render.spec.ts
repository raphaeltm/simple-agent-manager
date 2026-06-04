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
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SCREENSHOTS_DIR = path.resolve(
  __dirname,
  '../../../../.codex/tmp/playwright-screenshots'
);

const MOCK_USER = {
  user: {
    id: 'user-demo-1',
    email: 'demo@example.com',
    name: 'Demo User',
    image: null,
    role: 'superadmin',
    status: 'active',
    emailVerified: true,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  },
  session: {
    id: 'session-demo-1',
    userId: 'user-demo-1',
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
    token: 'mock-token',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  },
};

/**
 * Mock the API so the dashboard renders, but make the three credential-status
 * endpoints HANG forever. This simulates the slow `GET /api/github/installations`
 * that previously delayed the overlay. If the overlay still appears, it is no
 * longer gated on these calls.
 */
async function setupSlowStatusMocks(page: Page) {
  await page.route('**/api/**', async (route: Route) => {
    const url = new URL(route.request().url());
    const p = url.pathname;
    const respond = (status: number, body: unknown) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

    if (p.includes('/api/auth/')) return respond(200, MOCK_USER);

    // The three credential-status endpoints the overlay used to wait on — hang.
    if (p === '/api/github/installations') return; // never fulfilled
    if (p === '/api/credentials' && route.request().method() === 'GET') return; // hang
    if (p === '/api/credentials/agent' && route.request().method() === 'GET') return; // hang

    // Dashboard data — respond so the shell paints normally.
    if (p === '/api/dashboard/active-tasks') return respond(200, { tasks: [] });
    if (p.startsWith('/api/notifications')) return respond(200, { notifications: [], unreadCount: 0 });
    if (p === '/api/agents') return respond(200, []);
    if (p === '/api/trial-status') return respond(200, { available: false });
    if (p === '/api/projects' && route.request().method() === 'GET') return respond(200, { projects: [] });
    if (p.startsWith('/api/workspaces')) return respond(200, []);

    return respond(200, {});
  });
}

async function assertNoOverflow(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth
  );
  expect(overflow).toBe(false);
}

test('?onboarding overlay renders instantly despite a hung status fetch', async ({ page }, testInfo) => {
  await setupSlowStatusMocks(page);

  await page.goto('/dashboard?onboarding');

  // The overlay must appear well within the old ~5-6s window. 3s is a generous
  // ceiling that still proves the fetch (which never resolves) does not gate it.
  const wizard = page.locator('[data-testid="onboarding-wizard"]');
  await expect(wizard).toBeVisible({ timeout: 3000 });

  await assertNoOverflow(page);

  const viewport = testInfo.project.name.includes('Desktop') ? 'desktop' : 'mobile';
  await page.waitForTimeout(600);
  await page.screenshot({
    path: path.join(SCREENSHOTS_DIR, `onboarding-overlay-instant-${viewport}.png`),
    fullPage: true,
  });
});
