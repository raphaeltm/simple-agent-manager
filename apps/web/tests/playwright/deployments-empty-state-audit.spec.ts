import { expect, type Page, type Route, test } from '@playwright/test';

import { assertNoOverflow, makeMockUser, screenshot, seedTheme } from './audit-helpers';

// ---------------------------------------------------------------------------
// Mock Data
// ---------------------------------------------------------------------------

const MOCK_USER = makeMockUser({
  email: 'test@example.com',
  name: 'Test User',
  role: 'superadmin',
  sessionId: 'session-deploy-1',
  userId: 'user-deploy-1',
});

const MOCK_PROJECT = {
  id: 'proj-deploy-1',
  name: 'Deploy Audit Project',
  repository: 'testuser/deploy-audit',
  defaultBranch: 'main',
  userId: 'user-deploy-1',
  githubInstallationId: 'inst-1',
  defaultVmSize: null,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

// ---------------------------------------------------------------------------
// API Mock Setup
// ---------------------------------------------------------------------------

async function setupApiMocks(page: Page) {
  await page.route('**/api/**', async (route: Route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;

    const respond = (status: number, body: unknown) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

    // Auth
    if (path.includes('/api/auth/')) return respond(200, MOCK_USER);

    // Global endpoints
    if (path === '/api/projects') return respond(200, { projects: [MOCK_PROJECT], nextCursor: null });
    if (path === '/api/dashboard/active-tasks') return respond(200, { tasks: [] });
    if (path === '/api/github/installations') return respond(200, []);
    if (path.startsWith('/api/notifications')) return respond(200, { notifications: [], unreadCount: 0 });
    if (path.startsWith('/api/credentials')) return respond(200, []);
    if (path.startsWith('/api/trial')) return respond(200, { available: false });
    if (path === '/api/agents') return respond(200, { agents: [] });

    // Project subresources (required by project layout)
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
    test('renders friendly empty-state guidance', async ({ page }) => {
      await seedTheme(page, theme);
      await setupApiMocks(page);

      // Desktop
      await page.setViewportSize({ width: 1280, height: 800 });
      await page.goto(`/projects/${MOCK_PROJECT.id}/deployments`);

      // Assert real content rendered — not a blank Vite shell or ErrorBoundary
      await expect(page.getByRole('heading', { name: 'Deploy apps with your agents' })).toBeVisible();
      await expect(page.getByText('Something went wrong')).toHaveCount(0);

      // Docs link opens in new tab
      const docsLink = page.getByRole('link', { name: /Learn how deployments work/ });
      await expect(docsLink).toBeVisible();
      await expect(docsLink).toHaveAttribute('target', '_blank');
      await expect(docsLink).toHaveAttribute('rel', 'noopener noreferrer');

      // "Create first environment" button pre-fills name input
      await page.getByRole('button', { name: 'Create first environment' }).click();
      const nameInput = page.locator('#deployment-env-name');
      await expect(nameInput).toHaveValue('staging');

      await screenshot(page, `deployments-empty-${theme}`);
      await assertNoOverflow(page);

      // Mobile
      await page.setViewportSize({ width: 375, height: 667 });
      await page.waitForTimeout(600);

      await expect(page.getByRole('heading', { name: 'Deploy apps with your agents' })).toBeVisible();

      await screenshot(page, `deployments-empty-mobile-${theme}`);
      await assertNoOverflow(page);
    });
  });
}
