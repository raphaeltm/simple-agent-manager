import { type Page, test } from '@playwright/test';

import {
  assertNoOverflow,
  makeMockUser,
  screenshot,
  seedTheme,
  setupAuditRoutes,
  visitAndCapture,
} from './audit-helpers';

/**
 * Light-mode visual audit for the Tools surfaces (/tools, /tools/cli).
 *
 * These screens had dark-assuming overlays (bg-white/[0.0x] chip washes) and a
 * WCAG-AA contrast bug on the CLI download CTA (text-black on the green accent).
 * This audit captures both dark and light at every viewport project so future
 * light-mode regressions on the CTA and chips fail CI.
 */

const MOCK_USER = makeMockUser({
  email: 'tools-audit@example.com',
  name: 'Tools Audit User',
  role: 'user',
  sessionId: 'session-tools-audit',
  userId: 'user-tools-audit',
});

const CLI_VERSION = {
  available: true,
  version: '1.42.0',
  buildDate: '2026-06-01T00:00:00Z',
};

async function setupMocks(page: Page) {
  await setupAuditRoutes(page, (path, respond) => {
    if (path.includes('/api/auth/')) return respond(200, MOCK_USER);
    if (path === '/api/cli/version') return respond(200, CLI_VERSION);
    if (path === '/api/github/installations') return respond(200, []);
    if (path === '/api/agents') return respond(200, []);
    if (path.startsWith('/api/credentials')) return respond(200, []);
    if (path === '/api/dashboard/active-tasks') return respond(200, { tasks: [] });
    if (path === '/api/projects') return respond(200, { projects: [], total: 0 });
    if (path === '/api/chats' || path === '/api/chats/recent')
      return respond(200, { sessions: [], total: 0 });
    if (path === '/api/nodes') return respond(200, []);
    if (path === '/api/trial-status') return respond(200, { isTrial: false });
    if (path === '/api/notifications/unread-count') return respond(200, { count: 0 });
    if (path === '/api/notifications')
      return respond(200, { notifications: [], unreadCount: 0, nextCursor: null });
    return undefined;
  });
}

for (const theme of ['dark', 'light'] as const) {
  test.describe(`Tools theme audit — ${theme}`, () => {
    test('surfaces', async ({ page }) => {
      await seedTheme(page, theme);
      await setupMocks(page);
      const suffix = `${theme}-${page.viewportSize()?.width ?? 'unknown'}`;

      // /tools — grid of tool cards (available + coming-soon chips on bg-inset)
      await visitAndCapture(page, '/tools', `tools-grid-${suffix}`, theme);

      // /tools/cli — download CTA (accent fill + text-fg-on-accent) + other-platforms chips
      await visitAndCapture(page, '/tools/cli', `tools-cli-${suffix}`, theme);

      // Expand the "Other platforms" disclosure to render the bg-inset chip rows.
      await page.getByRole('button', { name: 'Other platforms' }).click();
      await page.waitForTimeout(300);
      await screenshot(page, `tools-cli-platforms-${suffix}`);
      await assertNoOverflow(page);
    });
  });
}
