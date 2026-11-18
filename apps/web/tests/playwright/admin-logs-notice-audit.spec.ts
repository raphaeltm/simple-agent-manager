/**
 * Admin → Logs and Admin → Stream follow the installation's log capabilities (rule 17).
 *
 * `GET /api/config/platform-capabilities` reports `logSearch` (Workers Observability) and
 * `liveLogStream` (a tail worker). A self-hosted box has neither, so each page shows where to
 * read logs on the server instead of a search that errors or a stream that never receives
 * anything. A Cloudflare installation reports both and keeps the real viewers (the control).
 *
 * The capabilities answer drives the real fetch -> query -> hook -> render path; no flag is
 * hand-fed to a component (rule 62). Captured in both themes at the project's mobile and
 * desktop viewports; `assertNoOverflow` also walks clipped overflow (rule 56), and the notice's
 * long command lines must stay inside their own scroller.
 */
import { expect, type Page, type Route, test } from '@playwright/test';

import {
  assertNoOverflow,
  expectTheme,
  makeMockUser,
  screenshot,
  seedTheme,
} from './audit-helpers';

const MOCK_USER = makeMockUser({
  email: 'admin@example.com',
  name: 'Admin User',
  role: 'superadmin',
  sessionId: 'session-admin-1',
  userId: 'user-admin-1',
});

const SELF_HOSTED = {
  speechToText: false,
  textToSpeech: false,
  logSearch: false,
  liveLogStream: false,
  agentModelCalls: false,
};
const CLOUDFLARE = { ...SELF_HOSTED, logSearch: true, liveLogStream: true };

async function setupMocks(page: Page, capabilities: Record<string, boolean>) {
  const logRequests: string[] = [];
  const respond = (route: Route, status: number, body: unknown) =>
    route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

  // The first-run onboarding wizard overlays every authenticated page for a user with no
  // credentials and would cover the surface under test (rule 62); mark it dismissed first.
  await page.addInitScript(
    (id) => localStorage.setItem(`sam-onboarding-wizard-dismissed-${id}`, 'true'),
    MOCK_USER.user.id
  );
  await page.routeWebSocket('**/api/notifications/ws', () => undefined);
  await page.routeWebSocket('**/api/admin/observability/logs/stream**', (ws) => {
    logRequests.push('stream-ws');
    ws.send(JSON.stringify({ type: 'status', status: 'connected' }));
  });
  await page.route('**/api/**', async (route: Route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/config/platform-capabilities') return respond(route, 200, capabilities);
    if (path.includes('/api/auth/')) return respond(route, 200, MOCK_USER);
    if (path.startsWith('/api/notifications')) {
      return respond(route, 200, { notifications: [], unreadCount: 0 });
    }
    if (path.startsWith('/api/admin/observability/logs')) {
      logRequests.push(path);
      return respond(route, 200, { logs: [], cursor: null, hasMore: false });
    }
    if (path === '/api/credentials' || path === '/api/github/installations') {
      return respond(route, 200, []);
    }
    if (path.startsWith('/api/projects'))
      return respond(route, 200, { projects: [], nextCursor: null });
    return respond(route, 200, {});
  });
  return { logRequests };
}

/** Whether `locator` is what a user would hit at its own center: nothing is drawn over it. */
async function isTopmost(locator: ReturnType<Page['locator']>): Promise<boolean> {
  return locator.evaluate((el) => {
    const box = el.getBoundingClientRect();
    const hit = document.elementFromPoint(
      box.left + box.width / 2,
      box.top + Math.min(box.height / 2, 40)
    );
    return hit !== null && el.contains(hit);
  });
}

const SURFACES = [
  {
    slug: 'logs',
    path: '/admin/logs',
    heading: 'Log search is not available on this installation.',
    viewerLabel: 'Worker script name',
  },
  {
    slug: 'stream',
    path: '/admin/stream',
    heading: 'The live log stream is not available on this installation.',
    viewerLabel: 'Search stream',
  },
] as const;

/**
 * The project's own viewport (CI runs a mobile project) plus an explicit desktop layout, so both
 * mobile and desktop evidence come from every run.
 */
const LAYOUTS = [
  { name: 'project viewport', slug: 'mobile', use: undefined },
  {
    name: 'desktop 1280x800',
    slug: 'desktop',
    use: { viewport: { width: 1280, height: 800 }, isMobile: false, hasTouch: false },
  },
] as const;

for (const layout of LAYOUTS) {
  for (const surface of SURFACES) {
    test.describe(`Admin ${surface.slug} — self-hosted notice (${layout.name})`, () => {
      if (layout.use) test.use(layout.use);
      for (const theme of ['dark', 'light'] as const) {
        test(`shows where to read logs (${theme})`, async ({ page }) => {
          await seedTheme(page, theme);
          const { logRequests } = await setupMocks(page, SELF_HOSTED);
          await page.goto(surface.path);

          const notice = page.getByTestId('box-logs-notice');
          await expect(notice).toBeVisible();
          // Visible to a user, not just present: no overlay sits on top of it.
          expect(await isTopmost(notice)).toBe(true);
          await expect(notice).toContainText(surface.heading);
          await expect(notice).toContainText('docker compose logs -f --since 30m celld');
          await expect(notice).toContainText('Errors that SAM records itself');
          await expectTheme(page, theme);

          // The command block scrolls inside itself; it must not widen the page.
          const pre = notice.locator('pre');
          const [preBox, noticeBox] = await Promise.all([pre.boundingBox(), notice.boundingBox()]);
          expect(preBox).not.toBeNull();
          expect(noticeBox).not.toBeNull();
          expect(preBox!.x + preBox!.width).toBeLessThanOrEqual(
            noticeBox!.x + noticeBox!.width + 1
          );
          expect(await pre.evaluate((el) => getComputedStyle(el).overflowX)).toBe('auto');

          // Nothing is asked of a log backend the box does not have.
          expect(logRequests).toEqual([]);

          await screenshot(page, `admin-${surface.slug}-notice-${theme}-${layout.slug}`);
          await assertNoOverflow(page);
        });
      }
    });

    test.describe(`Admin ${surface.slug} — Cloudflare control (${layout.name})`, () => {
      if (layout.use) test.use(layout.use);
      test('keeps the real viewer when the installation has it', async ({ page }) => {
        await seedTheme(page, 'dark');
        await setupMocks(page, CLOUDFLARE);
        await page.goto(surface.path);

        // Liveness: the real viewer rendered, and the notice did not.
        await expect(page.getByLabel(surface.viewerLabel)).toBeVisible();
        expect(await isTopmost(page.getByLabel(surface.viewerLabel))).toBe(true);
        await expect(page.getByTestId('box-logs-notice')).toHaveCount(0);

        await screenshot(page, `admin-${surface.slug}-cloudflare-${layout.slug}`);
        await assertNoOverflow(page);
      });
    });
  }
}
