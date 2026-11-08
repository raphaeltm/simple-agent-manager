import { expect, type Route, test } from '@playwright/test';

import {
  assertNoOverflow,
  expectTheme,
  makeMockUser,
  screenshot,
  seedTheme,
} from './audit-helpers';

/**
 * Visual audit for the anonymous-trial retirement:
 *  - stale `/try` links land on the retired-trial page, which links to the self-hosting guide
 *  - the admin AI usage cards no longer split out trial requests/cost
 */

const respond = (route: Route, status: number, body: unknown) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

for (const theme of ['dark', 'light'] as const) {
  for (const path of ['/try', '/try/trial_01HZYQ8K3W9M2V7R5T0X4B6N8C', '/try/waitlist/thanks']) {
    test(`retired trial link ${path} (${theme})`, async ({ page }) => {
      await seedTheme(page, theme);
      await page.route('**/api/**', (route) => respond(route, 401, { error: 'UNAUTHORIZED' }));
      // Capture where "Self-host SAM" goes without leaving the test environment.
      const followed: string[] = [];
      await page.route(/^https:\/\/(?!localhost)[^/]+\/self-host\/.*/, (route) => {
        followed.push(route.request().url());
        return route.fulfill({ status: 200, contentType: 'text/html', body: '<h1>Self-host</h1>' });
      });

      await page.goto(path);
      await expect(page.getByRole('heading', { name: 'Hosted trials have ended' })).toBeVisible();
      await expectTheme(page, theme);
      // Nothing navigates on its own: the page is still here after it settles.
      await page.waitForTimeout(800);
      expect(followed).toEqual([]);
      expect(new URL(page.url()).pathname).toBe(path);
      const signIn = page.getByRole('link', { name: 'Already have access? Sign in' });
      await expect(signIn).toHaveAttribute('href', '/');
      expect((await signIn.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      await assertNoOverflow(page);
      const slug = path === '/try' ? 'root' : path.includes('waitlist') ? 'waitlist' : 'trial-id';
      await screenshot(page, `retired-trial-${slug}-${theme}`);

      // The primary action reaches the self-hosting guide.
      await page.getByRole('link', { name: 'Self-host SAM' }).click();
      await expect.poll(() => followed.length).toBe(1);
      expect(followed[0]).toMatch(/\/self-host\/$/);
    });
  }
}

const ADMIN = makeMockUser({
  email: 'admin@example.com',
  name: 'Admin User',
  role: 'superadmin',
  sessionId: 'session-admin-1',
  userId: 'user-admin-1',
});

function aiUsage(kind: 'normal' | 'empty' | 'large') {
  const n = kind === 'large' ? 987_654_321 : kind === 'empty' ? 0 : 4321;
  return {
    totalRequests: n,
    totalInputTokens: n * 900,
    totalOutputTokens: n * 210,
    totalCostUsd: kind === 'empty' ? 0 : n / 1000,
    cachedRequests: Math.floor(n / 7),
    errorRequests: kind === 'empty' ? 0 : Math.floor(n / 50),
    byModel:
      kind === 'empty'
        ? []
        : Array.from({ length: kind === 'large' ? 30 : 3 }, (_, i) => ({
            model: `@cf/vendor/${'very-long-model-name-'.repeat(kind === 'large' ? 4 : 1)}${i}`,
            provider: 'workers-ai',
            requests: 100 + i,
            inputTokens: 9000 + i,
            outputTokens: 2000 + i,
            totalTokens: 11000 + i,
            costUsd: 1.5 + i,
            cachedRequests: i,
            errorRequests: 0,
          })),
    byDay: [],
    period: '7d',
  };
}

for (const kind of ['normal', 'empty', 'large'] as const) {
  test(`admin AI usage cards without a trial split (${kind})`, async ({ page }) => {
    await page.addInitScript(
      (id) => localStorage.setItem(`sam-onboarding-wizard-dismissed-${id}`, 'true'),
      ADMIN.user.id
    );
    await page.routeWebSocket('**/api/notifications/ws', () => undefined);
    await page.route('**/api/**', (route) => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname.includes('/api/auth/')) return respond(route, 200, ADMIN);
      if (pathname.startsWith('/api/notifications'))
        return respond(route, 200, { notifications: [], unreadCount: 0 });
      if (pathname.includes('/admin/analytics/ai-usage')) return respond(route, 200, aiUsage(kind));
      if (pathname === '/api/credentials' || pathname === '/api/github/installations')
        return respond(route, 200, []);
      if (pathname === '/api/projects') return respond(route, 200, { projects: [] });
      return respond(route, 200, {});
    });
    await page.goto('/admin/analytics');
    const heading = page.getByText(/^AI Usage \(/);
    await expect(heading).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText('Trials', { exact: true })).toHaveCount(0);
    if (kind !== 'empty') await expect(page.getByText('Cached', { exact: true })).toBeVisible();
    await heading.scrollIntoViewIfNeeded();
    await assertNoOverflow(page);
    await screenshot(page, `admin-ai-usage-${kind}`);
  });
}
