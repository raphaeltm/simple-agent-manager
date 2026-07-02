import { expect, type Page, test } from '@playwright/test';

import { assertNoOverflow, makeMockUser, screenshot, seedTheme, setupAuditRoutes } from './audit-helpers';

const MOCK_USER = makeMockUser({
  email: 'test@example.com',
  name: 'Test User',
  sessionId: 'session-1',
  userId: 'user-1',
});

const INSTALLATIONS = [
  { id: 'inst-1', accountName: 'a-fairly-long-github-organization-name-inc', accountType: 'Organization' },
  { id: 'inst-2', accountName: 'personal-account', accountType: 'User' },
];

const AGENTS = [
  { id: 'claude-code', name: 'Claude Code', configured: true, models: ['claude-sonnet-4-5'] },
  { id: 'openai-codex', name: 'OpenAI Codex', configured: true, models: ['gpt-5'] },
];

async function setupMocks(
  page: Page,
  opts: { installations?: unknown[]; artifactsEnabled?: boolean } = {},
) {
  const { installations = INSTALLATIONS, artifactsEnabled = true } = opts;
  await setupAuditRoutes(page, (path, respond) => {
    if (path.endsWith('/api/github/installations')) return respond(200, installations);
    if (path.endsWith('/api/github/repositories')) {
      return respond(200, { repositories: [], failedInstallations: [] });
    }
    if (path.endsWith('/api/config/artifacts-enabled')) return respond(200, { enabled: artifactsEnabled });
    if (path.endsWith('/api/agents')) return respond(200, { agents: AGENTS });
    if (path.endsWith('/api/credentials')) return respond(200, [{ provider: 'hetzner', status: 'valid' }]);
    if (path.endsWith('/api/trial/status')) return respond(200, { available: false });
    // App-shell surfaces that load on every authed page.
    if (path.endsWith('/api/projects')) return respond(200, { projects: [], total: 0, hasMore: false });
    if (path.endsWith('/api/notifications')) return respond(200, { notifications: [], unreadCount: 0, hasMore: false });
    return undefined;
  });
  // Register auth last so it wins over the catch-all (last route registered wins).
  await page.route('**/api/auth/get-session', (route) => route.fulfill({ status: 200, json: MOCK_USER }));
}

async function gotoWizard(page: Page) {
  await seedTheme(page, 'dark');
  await page.goto('/projects/new');
  await expect(page.getByRole('heading', { name: "Let's create your project" })).toBeVisible();
}

test.describe('Project onboarding wizard', () => {
  test('captures every step with no horizontal overflow', async ({ page }) => {
    await setupMocks(page);
    await gotoWizard(page);

    await screenshot(page, 'onboarding-01-welcome');
    await assertNoOverflow(page);

    await page.getByRole('button', { name: /Get started/ }).click();
    await expect(page.getByRole('heading', { name: 'How SAM works' })).toBeVisible();
    await screenshot(page, 'onboarding-02-how-sam-works');
    await assertNoOverflow(page);

    await page.getByRole('button', { name: /Continue/ }).click();
    await expect(page.getByRole('heading', { name: /Where should your code live/ })).toBeVisible();
    await expect(page.getByText('Let SAM host the repository')).toBeVisible();
    await screenshot(page, 'onboarding-03-provider');
    await assertNoOverflow(page);

    // Connect — GitHub
    await page.getByRole('button', { name: /Continue/ }).click();
    await expect(page.getByRole('heading', { name: 'Connect your code' })).toBeVisible();
    await screenshot(page, 'onboarding-04-connect-github');
    await assertNoOverflow(page);

    // Connect — SAM (Artifacts), with a long project name to stress the layout
    await page.getByRole('button', { name: /^Back/ }).click();
    await expect(page.getByRole('heading', { name: /Where should your code live/ })).toBeVisible();
    await page.getByText('Let SAM host the repository').click();
    await page.getByRole('button', { name: /Continue/ }).click();
    await expect(page.getByRole('heading', { name: 'Name your project' })).toBeVisible();
    await page
      .getByPlaceholder('Project name')
      .fill('an-extremely-long-greenfield-project-name-that-should-wrap-not-overflow');
    await screenshot(page, 'onboarding-04-connect-artifacts');
    await assertNoOverflow(page);
  });

  test('hides the SAM option when Artifacts is disabled', async ({ page }) => {
    await setupMocks(page, { artifactsEnabled: false });
    await gotoWizard(page);
    await page.getByRole('button', { name: /Get started/ }).click();
    await page.getByRole('button', { name: /Continue/ }).click();
    await expect(page.getByRole('heading', { name: /Where should your code live/ })).toBeVisible();
    await expect(page.getByText('Connect a GitHub repository')).toBeVisible();
    await expect(page.getByText('Let SAM host the repository')).toHaveCount(0);
    await assertNoOverflow(page);
  });

  test('shows the GitHub-App install warning when no installations exist', async ({ page }) => {
    await setupMocks(page, { installations: [] });
    await gotoWizard(page);
    await page.getByRole('button', { name: /Get started/ }).click();
    await page.getByRole('button', { name: /Continue/ }).click();
    await page.getByRole('button', { name: /Continue/ }).click();
    await expect(page.getByText(/Install the GitHub App/)).toBeVisible();
    await screenshot(page, 'onboarding-connect-github-no-install');
    await assertNoOverflow(page);
  });
});
