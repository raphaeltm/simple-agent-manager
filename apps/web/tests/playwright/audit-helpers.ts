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

export function getProjectSuffix(projectName: string): string {
  return projectName.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
}

export function jsonResponse(route: Route, status: number, body: unknown) {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
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
