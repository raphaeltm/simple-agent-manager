import { type Page, type Route, test } from '@playwright/test';

import { assertNoOverflow, screenshot } from './audit-helpers';

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
  name: 'Test Project ñoño 日本語',
  repository: 'testuser/test-repo',
  defaultBranch: 'main',
  userId: 'user-test-1',
  githubInstallationId: 'inst-1',
  defaultVmSize: 'medium',
  defaultProvider: null,
  defaultLocation: null,
  workspaceIdleTimeoutMs: 1800000,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

async function setupMocks(page: Page) {
  await page.route('**/api/**', async (route: Route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;

    if (path.includes('/api/auth/'))
      return route.fulfill({ json: MOCK_USER });

    if (path === '/api/agents')
      return route.fulfill({
        json: {
          agents: [{ id: 'claude-code', name: 'Claude Code', description: 'AI coding assistant' }],
        },
      });

    if (path.includes('/credentials/agent'))
      return route.fulfill({
        json: {
          credentials: [{ agentType: 'claude-code', credentialKind: 'api-key', isActive: true }],
        },
      });

    if (path.includes('/credentials'))
      return route.fulfill({
        json: [{ id: 'cred-1', userId: 'user-test-1', provider: 'hetzner', isActive: true, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' }],
      });

    if (path.includes('/capacity-pools'))
      return route.fulfill({
        json: { effective: null, effectiveScope: null, defaults: [], precedence: ['project', 'user', 'installation'], reconciledScopes: [], policyMutationSupported: false },
      });

    if (path.includes('/providers/catalog'))
      return route.fulfill({ json: { catalogs: [] } });

    if (path.includes('/agent-profiles'))
      return route.fulfill({ json: [] });

    if (path.includes('/skills'))
      return route.fulfill({ json: [] });

    if (path.includes('/sessions'))
      return route.fulfill({ json: [] });

    if (path.includes('/tasks'))
      return route.fulfill({ json: [] });

    if (path.includes('/triggers'))
      return route.fulfill({ json: [] });

    if (path.match(/\/api\/projects\/[^/]+$/))
      return route.fulfill({ json: MOCK_PROJECT });

    if (path.includes('/api/projects'))
      return route.fulfill({ json: [] });

    if (path.includes('/api/nodes'))
      return route.fulfill({ json: [] });

    if (path.includes('/api/notifications'))
      return route.fulfill({ json: { notifications: [] } });

    if (path.includes('/installations'))
      return route.fulfill({ json: [{ id: 'inst-1', accountLogin: 'testuser' }] });

    return route.fulfill({ json: {} });
  });

  await page.route('**/ws/**', (route) => route.abort());
}

test.describe('Resource Requirements — Project Settings (Mobile 375)', () => {
  test.use({ viewport: { width: 375, height: 667 }, isMobile: true });

  test('infra section renders compactly', async ({ page }) => {
    await setupMocks(page);
    await page.goto('/projects/proj-test-1/settings/infrastructure');
    await page.waitForTimeout(2500);
    await screenshot(page, 'rr-proj-settings-infra-mobile');
    await assertNoOverflow(page);
  });
});

test.describe('Resource Requirements — Project Settings (Desktop 1280)', () => {
  test.use({ viewport: { width: 1280, height: 800 }, isMobile: false });

  test('infra section at desktop width', async ({ page }) => {
    await setupMocks(page);
    await page.goto('/projects/proj-test-1/settings/infrastructure');
    await page.waitForTimeout(2500);
    await screenshot(page, 'rr-proj-settings-infra-desktop');
    await assertNoOverflow(page);
  });
});

test.describe('Resource Requirements — No horizontal scroll 320px', () => {
  test.use({ viewport: { width: 320, height: 568 }, isMobile: true });

  test('fits within 320px viewport', async ({ page }) => {
    await setupMocks(page);
    await page.goto('/projects/proj-test-1/settings/infrastructure');
    await page.waitForTimeout(2500);
    await screenshot(page, 'rr-proj-settings-infra-320');
    await assertNoOverflow(page);
  });
});
