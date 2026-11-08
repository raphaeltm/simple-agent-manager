import { expect, type Page, type Route, test } from '@playwright/test';

import { assertNoOverflow, makeMockUser, screenshot } from './audit-helpers';

/**
 * Visual audit for the anonymous-trial retirement:
 *  - stale `/try` links land on the retired-trial page, which redirects to the self-hosting guide
 *  - the admin AI usage cards no longer split out trial requests/cost
 */

const respond = (route: Route, status: number, body: unknown) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

async function holdExternalRedirect(page: Page): Promise<string[]> {
  // The page redirects to the public website straight away. Answer that navigation with 204 No
  // Content, which browsers do not navigate to, so the fallback card stays on screen for the
  // screenshot, and record the target.
  const attempted: string[] = [];
  await page.route(/^https:\/\/(?!localhost)[^/]+\/self-host\/.*/, (route) => {
    attempted.push(route.request().url());
    return route.fulfill({ status: 204 });
  });
  await page.route('**/api/**', (route) => respond(route, 401, { error: 'UNAUTHORIZED' }));
  return attempted;
}

for (const path of ['/try', '/try/trial_01HZYQ8K3W9M2V7R5T0X4B6N8C', '/try/waitlist/thanks']) {
  test(`retired trial link ${path}`, async ({ page }) => {
    const attempted = await holdExternalRedirect(page);
    await page.goto(path);
    await expect(page.getByRole('heading', { name: 'Hosted trials have ended' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Self-host SAM' })).toHaveAttribute(
      'href',
      /\/self-host\/$/
    );
    await expect.poll(() => attempted.length).toBeGreaterThan(0);
    expect(attempted[0]).toMatch(/\/self-host\/$/);
    await assertNoOverflow(page);
    const slug = path === '/try' ? 'root' : path.includes('waitlist') ? 'waitlist' : 'trial-id';
    await screenshot(page, `retired-trial-${slug}`);
  });
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
