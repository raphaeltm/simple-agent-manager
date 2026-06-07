import { mkdirSync } from 'node:fs';

import { expect, type Page, type Route } from '@playwright/test';

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
 * Seeds the theme before the app boots by writing the `sam-theme` localStorage
 * key. The ThemeContext reads this on mount and applies `data-ui-theme` on the
 * `<html>` element.
 */
export async function seedTheme(page: Page, theme: 'dark' | 'light') {
  await page.addInitScript((value) => {
    window.localStorage.setItem('sam-theme', value);
  }, theme);
}

/**
 * Asserts the active theme resolved to the expected `data-ui-theme` token on
 * `<html>` (`sam` for dark, `sam-light` for light).
 */
export async function expectTheme(page: Page, theme: 'dark' | 'light') {
  const expected = theme === 'dark' ? 'sam' : 'sam-light';
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
 * Registers the `**​/api/**` catch-all route used by the theme audits. The
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

  await page.route(`**/api/projects/${projectId}`, (route: Route) => {
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
