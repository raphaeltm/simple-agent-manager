import { mkdirSync } from 'node:fs';

import { expect, type Page, type Route, test } from '@playwright/test';

interface MockUserOptions {
  email: string;
  name: string;
  role?: string;
  sessionId: string;
  userId: string;
}

export function makeMockUser({ email, name, role = 'user', sessionId, userId }: MockUserOptions) {
  const timestamp = '2026-05-19T00:00:00Z';
  return {
    user: {
      id: userId,
      email,
      name,
      image: null,
      role,
      status: 'active',
      emailVerified: true,
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    session: {
      id: sessionId,
      userId,
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      token: 'mock-token',
      createdAt: timestamp,
      updatedAt: timestamp,
    },
  };
}

export async function screenshot(page: Page, name: string) {
  await page.waitForTimeout(600);
  const viewport = page.viewportSize();
  const suffix = viewport ? `-${viewport.width}x${viewport.height}` : '';
  const screenshotDir = `${process.cwd()}/.codex/tmp/playwright-screenshots`;
  mkdirSync(screenshotDir, { recursive: true });
  await page.screenshot({
    path: `${screenshotDir}/${name}${suffix}.png`,
    fullPage: true,
  });
}

export async function assertNoOverflow(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth
  );
  expect(overflow).toBe(false);
}

/**
 * Regression guard for the "System" label clipping inside the narrow (220px)
 * desktop sidebar. Document-level overflow checks do NOT catch a label that is
 * truncated *within* its own button — the button stays inside the viewport while
 * its text is clipped. This asserts every option button in the Theme group fully
 * contains its content (scrollWidth must not exceed clientWidth).
 */
export async function assertThemeButtonsNotClipped(page: Page) {
  const clipped = await page.evaluate(() => {
    const group = document.querySelector('[role="group"][aria-label="Theme"]');
    if (!group) return ['MISSING_GROUP'];
    const offenders: string[] = [];
    for (const btn of Array.from(group.querySelectorAll('button'))) {
      // +1 tolerance for sub-pixel rounding.
      if (btn.scrollWidth > btn.clientWidth + 1) {
        offenders.push(`${btn.textContent?.trim() ?? '?'}: ${btn.scrollWidth}>${btn.clientWidth}`);
      }
    }
    return offenders;
  });
  expect(clipped).toEqual([]);
}

/**
 * Seeds the theme before the app boots by writing the `sam-theme` localStorage
 * key. The ThemeContext reads this on mount and applies `data-ui-theme` on the
 * `<html>` element.
 *
 * For `'system'`, pass `prefersDark` to deterministically control the OS
 * preference: a `matchMedia` override is installed before the app boots so the
 * pre-paint script and ThemeContext resolve `system` to a known value.
 */
export async function seedTheme(
  page: Page,
  theme: 'dark' | 'light' | 'system',
  prefersDark = true,
) {
  await page.addInitScript(
    ({ value, dark }) => {
      window.localStorage.setItem('sam-theme', value);
      if (value === 'system') {
        // Only intercept `prefers-color-scheme` queries so OS-theme resolution
        // is deterministic. Delegate every other query (notably
        // `useIsMobile`'s `(max-width: 767px)` breakpoint) to the real
        // matchMedia so the AppShell still picks the correct mobile/desktop
        // render branch.
        const realMatchMedia = window.matchMedia.bind(window);
        // @ts-expect-error overriding for deterministic system resolution
        window.matchMedia = (query: string) => {
          if (query.includes('prefers-color-scheme')) {
            return {
              matches: query.includes('dark') ? dark : !dark,
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
      }
    },
    { value: theme, dark: prefersDark },
  );
}

/**
 * Asserts the active theme resolved to the expected `data-ui-theme` token on
 * `<html>` (`sam` for dark, `sam-light` for light). `effective` is the resolved
 * theme — for `system` seeds, pass the value the OS preference should resolve to.
 */
export async function expectTheme(page: Page, effective: 'dark' | 'light') {
  const expected = effective === 'dark' ? 'sam' : 'sam-light';
  const attr = await page.evaluate(() =>
    document.documentElement.getAttribute('data-ui-theme')
  );
  expect(attr).toBe(expected);
}

export function getProjectSuffix(projectName: string): string {
  return projectName.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
}

export function jsonResponse(route: Route, status: number, body: unknown) {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

/**
 * Polling variant of {@link expectTheme}. Waits for the ThemeContext to resolve
 * `data-ui-theme` rather than asserting synchronously, which is required when
 * the assertion runs immediately after `page.goto()` before the app has mounted.
 */
export async function expectThemePoll(page: Page, theme: 'dark' | 'light') {
  await expect
    .poll(() => page.evaluate(() => document.documentElement.getAttribute('data-ui-theme')))
    .toBe(theme === 'light' ? 'sam-light' : 'sam');
}

/**
 * Navigates to a route, waits for the expected theme to resolve, then captures a
 * full-page screenshot and asserts no horizontal overflow.
 *
 * Includes the ErrorBoundary false-pass guard: a crashed page keeps the seeded
 * `data-ui-theme` attribute and has no overflow, so the theme + overflow checks
 * both pass on the error screen. The "Something went wrong" assertion fails
 * loudly if the boundary rendered instead of the real surface.
 */
export async function visitAndCapture(
  page: Page,
  path: string,
  name: string,
  theme: 'dark' | 'light',
) {
  await page.goto(path);
  await expectThemePoll(page, theme);
  await page.waitForTimeout(700);
  await expect(page.getByText('Something went wrong')).toHaveCount(0);
  await screenshot(page, name);
  await assertNoOverflow(page);
}

export type AuditResponder = (status: number, body: unknown) => Promise<void>;

/**
 * Declares the standard dark + light theme audit describe/test scaffold shared by
 * every light-mode audit spec. For each theme it seeds the theme, registers the
 * spec's API mocks, computes the `theme-viewport` screenshot suffix, then invokes
 * the spec's `run` callback to capture its surfaces.
 */
export function describeThemeAudit(
  label: string,
  setupMocks: (page: Page) => Promise<void>,
  run: (page: Page, theme: 'dark' | 'light', suffix: string) => Promise<void>,
) {
  for (const theme of ['dark', 'light'] as const) {
    test.describe(`${label} — ${theme}`, () => {
      test('surfaces', async ({ page }) => {
        await seedTheme(page, theme);
        await setupMocks(page);
        const suffix = `${theme}-${page.viewportSize()?.width ?? 'unknown'}`;
        await run(page, theme, suffix);
      });
    });
  }
}

/**
 * Registers the catch-all `/api` glob route used by the theme audits. The
 * supplied handler returns the `respond(...)` promise for paths it handles and
 * `undefined` for everything else, which falls through to an empty `{}` 200 so
 * unmocked endpoints never hang the page.
 */
export async function setupAuditRoutes(
  page: Page,
  handler: (path: string, respond: AuditResponder) => Promise<void> | undefined,
) {
  await page.route('**/api/**', async (route: Route) => {
    const path = new URL(route.request().url()).pathname;
    const respond: AuditResponder = (status, body) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    const result = handler(path, respond);
    if (result === undefined) return respond(200, {});
    return result;
  });
}

interface ProjectChatMockOptions {
  projectId: string;
  project: unknown;
  session: unknown;
  messages: unknown[];
  user?: { id: string; name: string; email: string };
}

/**
 * Registers the common API route mocks needed to render a project chat session
 * (auth, project, session+messages, and the sidebar/dropdown data the page
 * loads). Specs supply their own session/messages and may register additional
 * routes (e.g. tool-content) after calling this — later-registered Playwright
 * routes take precedence for their specific URLs.
 */
export async function setupProjectChatMocks(page: Page, options: ProjectChatMockOptions) {
  const {
    projectId,
    project,
    session,
    messages,
    user = { id: 'test-user', name: 'Test User', email: 'test@example.com' },
  } = options;

  await page.route('**/api/auth/get-session', (route: Route) =>
    route.fulfill({ status: 200, json: { user } }),
  );

  await page.route('**/api/github/installations', (route: Route) =>
    route.fulfill({ status: 200, json: [] }),
  );

  await page.route(new RegExp(`/api/projects/${projectId}(?:\\?.*)?$`), (route: Route) => {
    if (route.request().method() === 'GET') {
      return route.fulfill({ status: 200, json: project });
    }
    return route.continue();
  });

  await page.route(new RegExp(`/api/projects/${projectId}/sessions/[^/]+(?:\\?.*)?$`), (route: Route) =>
    route.fulfill({ status: 200, json: { session, messages, hasMore: false } }),
  );

  await page.route(`**/api/projects/${projectId}/sessions*`, (route: Route) =>
    route.fulfill({ status: 200, json: { sessions: [session], total: 1 } }),
  );

  await page.route(`**/api/projects/${projectId}/tasks*`, (route: Route) =>
    route.fulfill({ status: 200, json: { tasks: [], total: 0 } }),
  );

  await page.route(`**/api/projects/${projectId}/agent-profiles`, (route: Route) =>
    route.fulfill({ status: 200, json: { items: [] } }),
  );

  await page.route('**/api/credentials', (route: Route) =>
    route.fulfill({ status: 200, json: [{ provider: 'hetzner', status: 'valid' }] }),
  );

  await page.route('**/api/trial/status', (route: Route) =>
    route.fulfill({ status: 200, json: { available: false } }),
  );

  await page.route('**/api/agents', (route: Route) =>
    route.fulfill({ status: 200, json: { agents: [] } }),
  );

  await page.route(`**/api/projects/${projectId}/commands*`, (route: Route) =>
    route.fulfill({ status: 200, json: { commands: [] } }),
  );
}
