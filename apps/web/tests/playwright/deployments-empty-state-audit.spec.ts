import { type Page, type Route, test } from '@playwright/test';

import { assertNoOverflow, screenshot, seedTheme } from './audit-helpers';

// ---------------------------------------------------------------------------
// Mock Data
// ---------------------------------------------------------------------------

const MOCK_USER = {
  user: {
    id: 'user-test-1',
    email: 'test@example.com',
    name: 'Test User',
    image: null,
    role: 'superadmin',
    status: 'active',
    emailVerified: true,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  },
  session: {
    id: 'session-test-1',
    userId: 'user-test-1',
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
    token: 'mock-token',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  },
};

const MOCK_PROJECT = {
  id: 'proj-test-1',
  name: 'My App',
  repository: 'demo/my-app',
  defaultBranch: 'main',
  userId: 'user-test-1',
  githubInstallationId: 'inst-1',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

// ---------------------------------------------------------------------------
// API Mock Setup
// ---------------------------------------------------------------------------

async function setupApiMocks(page: Page) {
  await page.route('http://localhost:8787/**', async (route: Route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;

    const respond = (status: number, body: unknown) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

    if (path.includes('/api/auth/')) return respond(200, MOCK_USER);
    if (path === '/api/projects') return respond(200, { projects: [MOCK_PROJECT] });
    if (path.startsWith('/api/notifications')) return respond(200, { notifications: [], unreadCount: 0 });
    if (path.startsWith('/api/credentials')) return respond(200, []);
    if (path.startsWith('/api/trial')) return respond(200, { available: false });

    // Project
    const projectMatch = path.match(/^\/api\/projects\/([^/]+)(\/.*)?$/);
    if (projectMatch) {
      const subPath = projectMatch[2] || '';
      if (subPath.includes('/environments')) return respond(200, { environments: [] });
      if (subPath.includes('/sessions')) return respond(200, { sessions: [], total: 0 });
      if (subPath.includes('/tasks')) return respond(200, { tasks: [], total: 0 });
      if (subPath.includes('/agent-profiles')) return respond(200, { items: [] });
      if (subPath.includes('/skills')) return respond(200, { items: [] });
      if (subPath.includes('/commands')) return respond(200, { commands: [] });
      if (!subPath) return respond(200, MOCK_PROJECT);
    }

    return respond(200, {});
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

for (const theme of ['dark', 'light'] as const) {
  test.describe(`Deployments empty state — ${theme}`, () => {
    test('renders friendly explanation', async ({ page }) => {
      await seedTheme(page, theme);
      await setupApiMocks(page);

      // Desktop
      await page.setViewportSize({ width: 1280, height: 800 });
      await page.goto('http://localhost:5173/projects/proj-test-1/deployments');
      await page.getByRole('heading', { name: 'Deploy apps with your agents' }).waitFor();
      await page.getByRole('link', { name: /Learn how deployments work/ }).waitFor();
      await page.waitForTimeout(1500);
      await screenshot(page, `deployments-empty-${theme}`);
      await assertNoOverflow(page);

      // Mobile
      await page.setViewportSize({ width: 375, height: 667 });
      await page.waitForTimeout(800);
      await page.getByRole('heading', { name: 'Deploy apps with your agents' }).waitFor();
      await screenshot(page, `deployments-empty-mobile-${theme}`);
      await assertNoOverflow(page);
    });
  });
}
