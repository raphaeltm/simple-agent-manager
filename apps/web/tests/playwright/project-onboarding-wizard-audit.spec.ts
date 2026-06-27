import { type Page, type Route, test } from '@playwright/test';

import { assertNoOverflow, makeMockUser, screenshot } from './audit-helpers';

const MOCK_USER = makeMockUser({
  email: 'test@example.com',
  name: 'Test User',
  role: 'superadmin',
  sessionId: 'session-1',
  userId: 'user-1',
});

const INSTALLATIONS = [
  { id: 'inst-1', accountName: 'acme-org', accountType: 'Organization' },
  { id: 'inst-2', accountName: 'personal-account', accountType: 'User' },
];

const REPOS = [
  { fullName: 'acme-org/frontend', defaultBranch: 'main', private: true, githubRepoId: 1001 },
  { fullName: 'acme-org/backend-api', defaultBranch: 'develop', private: true, githubRepoId: 1002 },
  { fullName: 'acme-org/infrastructure-as-code-monorepo-with-a-very-long-name', defaultBranch: 'main', private: false, githubRepoId: 1003 },
];

const BRANCHES = [
  { name: 'main' },
  { name: 'develop' },
  { name: 'feature/onboarding-wizard-with-a-really-long-branch-name' },
];

const AGENTS = [
  { id: 'claude-code', name: 'Claude Code', configured: true, models: ['claude-sonnet-4-5-20250514'] },
  { id: 'codex', name: 'Codex', configured: true, models: ['o4-mini'] },
  { id: 'aider', name: 'Aider', configured: false, models: [] },
];

async function setupApiMocks(page: Page, overrides: {
  installations?: unknown[];
  repos?: unknown[];
  branches?: unknown[];
  agents?: unknown[];
  createProjectError?: { status: number; body: unknown };
} = {}) {
  const {
    installations = INSTALLATIONS,
    repos = REPOS,
    branches = BRANCHES,
    agents = AGENTS,
  } = overrides;

  await page.route('**/api/auth/get-session', (route: Route) =>
    route.fulfill({ status: 200, json: MOCK_USER }),
  );

  await page.route('**/api/github/installations', (route: Route) =>
    route.fulfill({ status: 200, json: installations }),
  );

  await page.route('**/api/github/repos*', (route: Route) =>
    route.fulfill({ status: 200, json: repos }),
  );

  await page.route('**/api/github/branches*', (route: Route) =>
    route.fulfill({ status: 200, json: branches }),
  );

  await page.route('**/api/agents', (route: Route) =>
    route.fulfill({ status: 200, json: { agents } }),
  );

  await page.route('**/api/config/artifacts-enabled', (route: Route) =>
    route.fulfill({ status: 200, json: { enabled: false } }),
  );

  await page.route('**/api/credentials', (route: Route) =>
    route.fulfill({ status: 200, json: [{ provider: 'hetzner', status: 'valid' }] }),
  );

  await page.route('**/api/trial/status', (route: Route) =>
    route.fulfill({ status: 200, json: { available: false } }),
  );

  // Catch-all for remaining API routes
  await page.route('**/api/**', (route: Route) => {
    const url = route.request().url();
    if (url.includes('/api/projects') && route.request().method() === 'POST') {
      if (overrides.createProjectError) {
        return route.fulfill({
          status: overrides.createProjectError.status,
          json: overrides.createProjectError.body,
        });
      }
      return route.fulfill({
        status: 201,
        json: {
          id: 'proj-new-1',
          name: 'frontend',
          description: null,
          repository: 'acme-org/frontend',
          defaultBranch: 'main',
          installationId: 'inst-1',
          status: 'active',
          repoProvider: 'github',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          userId: 'user-1',
        },
      });
    }
    return route.fulfill({ status: 200, json: {} });
  });
}

test.describe('Project Onboarding Wizard — Mobile', () => {
  test.use({ viewport: { width: 375, height: 667 } });

  test('step 1: connect code form', async ({ page }) => {
    await setupApiMocks(page);
    await page.goto('/projects/new');
    await page.waitForTimeout(600);
    await screenshot(page, 'onboarding-wizard-step1-connect');
    await assertNoOverflow(page);
  });

  test('step 1: no installations warning', async ({ page }) => {
    await setupApiMocks(page, { installations: [] });
    await page.goto('/projects/new');
    await page.waitForTimeout(600);
    await screenshot(page, 'onboarding-wizard-no-installations');
    await assertNoOverflow(page);
  });

  test('step 1: validation error', async ({ page }) => {
    await setupApiMocks(page);
    await page.goto('/projects/new');
    await page.waitForTimeout(600);
    // Submit without filling in fields
    const form = page.locator('form');
    await form.evaluate((f) => {
      f.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await page.waitForTimeout(400);
    await screenshot(page, 'onboarding-wizard-validation-error');
    await assertNoOverflow(page);
  });
});

test.describe('Project Onboarding Wizard — Desktop', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('step 1: connect code form', async ({ page }) => {
    await setupApiMocks(page);
    await page.goto('/projects/new');
    await page.waitForTimeout(600);
    await screenshot(page, 'onboarding-wizard-step1-connect');
    await assertNoOverflow(page);
  });

  test('step 1: no installations warning', async ({ page }) => {
    await setupApiMocks(page, { installations: [] });
    await page.goto('/projects/new');
    await page.waitForTimeout(600);
    await screenshot(page, 'onboarding-wizard-no-installations');
    await assertNoOverflow(page);
  });
});
