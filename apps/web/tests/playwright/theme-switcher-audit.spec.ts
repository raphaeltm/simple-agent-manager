import { expect, type Page, type Route, test } from '@playwright/test';

import {
  assertNoOverflow,
  assertThemeButtonsNotClipped,
  expectTheme,
  screenshot,
  seedTheme,
} from './audit-helpers';

// ---------------------------------------------------------------------------
// Three-Way Theme Switcher Visual Audit
//
// Verifies the shared <ThemeSwitcher /> (Dark / Light / System) is discoverable
// and functional on the PRIMARY navigation surfaces at BOTH viewports:
//   - Desktop: AppShell sidebar footer
//   - Mobile: MobileNavDrawer (opened)
//
// For each surface we screenshot all three seeded states (dark / light / system)
// and exercise a live switch (click Light from a dark-seeded boot), asserting
// the resolved data-ui-theme token and that the group has zero horizontal
// overflow. `system` is seeded with a deterministic matchMedia override.
// ---------------------------------------------------------------------------

const MOCK_USER = {
  user: {
    id: 'user-test-1',
    email: 'test@example.com',
    name: 'Test User',
    image: null,
    role: 'user',
    status: 'active',
    emailVerified: true,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  },
  session: {
    id: 'session-test-1',
    userId: 'user-test-1',
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    token: 'mock-token',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  },
};

const PROJECT = {
  id: 'proj-test-1',
  name: 'My Project',
  repository: 'testuser/test-repo',
  defaultBranch: 'main',
  userId: 'user-test-1',
  githubInstallationId: 'inst-1',
  defaultVmSize: null,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

async function setupApiMocks(page: Page) {
  // Suppress the first-visit onboarding overlay, which otherwise renders a
  // full-screen modal (`data-testid="onboarding-wizard"`) that intercepts all
  // pointer events and blocks interaction with the nav surfaces under audit.
  await page.addInitScript((uid) => {
    window.localStorage.setItem(`sam-onboarding-wizard-dismissed-${uid}`, 'true');
  }, MOCK_USER.user.id);

  await page.route('**/api/**', async (route: Route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const respond = (status: number, body: unknown) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

    if (path.includes('/api/auth/')) return respond(200, MOCK_USER);
    if (path.match(/^\/api\/projects\/[^/]+\/sessions/)) return respond(200, { sessions: [], total: 0 });
    if (path.match(/^\/api\/projects\/[^/]+\/tasks/)) return respond(200, { tasks: [], nextCursor: null });
    if (path.match(/^\/api\/projects\/[^/]+\/activity/)) return respond(200, []);
    if (path.match(/^\/api\/projects\/[^/]+\/agent-profiles/)) return respond(200, { items: [] });
    if (path.match(/^\/api\/projects\/[^/]+$/) && route.request().method() === 'GET') return respond(200, PROJECT);
    if (path.includes('/notifications')) return respond(200, { notifications: [], unreadCount: 0 });
    if (path === '/api/credentials') return respond(200, []);
    if (path.includes('/credentials/agent')) return respond(200, { credentials: [] });
    if (path === '/api/dashboard/active-tasks') return respond(200, { tasks: [] });
    if (path === '/api/github/installations') return respond(200, []);
    if (path === '/api/agents') return respond(200, { agents: [] });
    if (path === '/api/projects') return respond(200, { projects: [PROJECT] });
    if (path === '/api/trial/status') return respond(200, { available: false });
    return respond(200, {});
  });
}

// Resolved-theme assertion is shared with the rest of the audit suite.
const expectResolved = expectTheme;

// ---------------------------------------------------------------------------
// Desktop — AppShell sidebar footer
// ---------------------------------------------------------------------------

test.describe('Theme Switcher — Desktop sidebar footer', () => {
  test.use({ viewport: { width: 1280, height: 800 }, isMobile: false, hasTouch: false });

  for (const { seed, prefersDark, resolved } of [
    { seed: 'dark', prefersDark: true, resolved: 'dark' },
    { seed: 'light', prefersDark: true, resolved: 'light' },
    { seed: 'system', prefersDark: true, resolved: 'dark' },
    { seed: 'system', prefersDark: false, resolved: 'light' },
  ] as const) {
    test(`renders switcher seeded ${seed}${seed === 'system' ? ` (OS ${prefersDark ? 'dark' : 'light'})` : ''}`, async ({ page }) => {
      await seedTheme(page, seed, prefersDark);
      await setupApiMocks(page);
      await page.goto('/dashboard');
      await page.waitForTimeout(800);

      const group = page.getByRole('group', { name: 'Theme' });
      await expect(group).toBeVisible();
      await expectResolved(page, resolved);
      // Active option is pressed.
      const activeLabel = seed === 'dark' ? 'Dark' : seed === 'light' ? 'Light' : 'System';
      await expect(group.getByRole('button', { name: activeLabel })).toHaveAttribute('aria-pressed', 'true');

      await screenshot(page, `theme-switcher-desktop-${seed}${seed === 'system' ? `-os-${prefersDark ? 'dark' : 'light'}` : ''}`);
      await assertNoOverflow(page);
      // C1 regression: "System" must not clip inside the 220px sidebar.
      await assertThemeButtonsNotClipped(page);
    });
  }

  test('clicking Light switches the resolved theme live', async ({ page }) => {
    await seedTheme(page, 'dark');
    await setupApiMocks(page);
    await page.goto('/dashboard');
    await page.waitForTimeout(800);
    await expectResolved(page, 'dark');

    const group = page.getByRole('group', { name: 'Theme' });
    await group.getByRole('button', { name: 'Light' }).click();
    await page.waitForTimeout(300);

    await expectResolved(page, 'light');
    await expect(group.getByRole('button', { name: 'Light' })).toHaveAttribute('aria-pressed', 'true');
    const persisted = await page.evaluate(() => window.localStorage.getItem('sam-theme'));
    expect(persisted).toBe('light');
    await screenshot(page, 'theme-switcher-desktop-after-switch-light');
    await assertNoOverflow(page);
  });
});

// ---------------------------------------------------------------------------
// Mobile — MobileNavDrawer
// ---------------------------------------------------------------------------

test.describe('Theme Switcher — Mobile nav drawer', () => {
  test.use({ viewport: { width: 375, height: 667 }, isMobile: true, hasTouch: true });

  for (const { seed, prefersDark, resolved } of [
    { seed: 'dark', prefersDark: true, resolved: 'dark' },
    { seed: 'light', prefersDark: true, resolved: 'light' },
    { seed: 'system', prefersDark: true, resolved: 'dark' },
    { seed: 'system', prefersDark: false, resolved: 'light' },
  ] as const) {
    test(`renders switcher in drawer seeded ${seed}${seed === 'system' ? ` (OS ${prefersDark ? 'dark' : 'light'})` : ''}`, async ({ page }) => {
      await seedTheme(page, seed, prefersDark);
      await setupApiMocks(page);
      await page.goto('/dashboard');
      await page.waitForTimeout(600);

      await page.click('[aria-label="Open navigation menu"]');
      await page.waitForTimeout(300);

      const group = page.getByRole('group', { name: 'Theme' });
      await expect(group).toBeVisible();
      await expectResolved(page, resolved);
      const activeLabel = seed === 'dark' ? 'Dark' : seed === 'light' ? 'Light' : 'System';
      await expect(group.getByRole('button', { name: activeLabel })).toHaveAttribute('aria-pressed', 'true');

      await screenshot(page, `theme-switcher-mobile-${seed}${seed === 'system' ? `-os-${prefersDark ? 'dark' : 'light'}` : ''}`);
      await assertNoOverflow(page);
    });
  }

  test('clicking System from a dark seed resolves via matchMedia', async ({ page }) => {
    // OS prefers light; selecting System should resolve to sam-light.
    await seedTheme(page, 'dark');
    await page.addInitScript(() => {
      // OS prefers light. Only override `prefers-color-scheme`; delegate other
      // queries (e.g. `useIsMobile`'s breakpoint) to the real matchMedia.
      const realMatchMedia = window.matchMedia.bind(window);
      // @ts-expect-error deterministic override
      window.matchMedia = (query: string) => {
        if (query.includes('prefers-color-scheme')) {
          return {
            matches: false,
            media: query,
            onchange: null,
            addEventListener: () => {},
            removeEventListener: () => {},
            addListener: () => {},
            removeListener: () => {},
            dispatchEvent: () => true,
          };
        }
        return realMatchMedia(query);
      };
    });
    await setupApiMocks(page);
    await page.goto('/dashboard');
    await page.waitForTimeout(600);

    await page.click('[aria-label="Open navigation menu"]');
    await page.waitForTimeout(300);

    const group = page.getByRole('group', { name: 'Theme' });
    await group.getByRole('button', { name: 'System' }).click();
    await page.waitForTimeout(300);

    await expectResolved(page, 'light');
    expect(await page.evaluate(() => window.localStorage.getItem('sam-theme'))).toBe('system');
    await screenshot(page, 'theme-switcher-mobile-after-switch-system');
    await assertNoOverflow(page);
  });
});
