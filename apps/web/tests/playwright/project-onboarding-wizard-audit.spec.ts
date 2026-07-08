import { expect, type Page, test } from '@playwright/test';

import {
  assertNoOverflow,
  makeMockUser,
  screenshot,
  seedTheme,
  setupAuditRoutes,
} from './audit-helpers';

const MOCK_USER = makeMockUser({
  email: 'test@example.com',
  name: 'Test User',
  sessionId: 'session-1',
  userId: 'user-1',
});

const INSTALLATIONS = [
  {
    id: 'inst-1',
    accountName: 'a-fairly-long-github-organization-name-inc',
    accountType: 'Organization',
  },
  { id: 'inst-2', accountName: 'personal-account', accountType: 'User' },
];

const GITLAB_PROJECTS = [
  {
    id: 123,
    pathWithNamespace: 'platform-experiments/a-very-long-gitlab-project-name-that-wraps-cleanly',
    name: 'a-very-long-gitlab-project-name-that-wraps-cleanly',
    private: true,
    defaultBranch: 'main',
    webUrl:
      'https://gitlab.com/platform-experiments/a-very-long-gitlab-project-name-that-wraps-cleanly',
    httpUrlToRepo:
      'https://gitlab.com/platform-experiments/a-very-long-gitlab-project-name-that-wraps-cleanly.git',
  },
  {
    id: 456,
    pathWithNamespace: 'team/compact',
    name: 'compact',
    private: true,
    defaultBranch: 'develop',
    webUrl: 'https://gitlab.com/team/compact',
    httpUrlToRepo: 'https://gitlab.com/team/compact.git',
  },
];

const AGENTS = [
  { id: 'claude-code', name: 'Claude Code', configured: true, models: ['claude-sonnet-4-5'] },
  { id: 'openai-codex', name: 'OpenAI Codex', configured: true, models: ['gpt-5'] },
];

const CREATED_PROJECT = {
  id: 'proj-audit-1',
  name: 'greenfield',
  description: null,
  repository: 'https://acct.artifacts.cloudflare.net/git/default/greenfield.git',
  defaultBranch: 'main',
  installationId: 'system_anonymous_trials_installation',
  status: 'active',
  repoProvider: 'artifacts',
  createdAt: '2026-07-02T00:00:00Z',
  updatedAt: '2026-07-02T00:00:00Z',
  userId: 'user-1',
};

async function setupMocks(
  page: Page,
  opts: { installations?: unknown[]; artifactsEnabled?: boolean; gitlabEnabled?: boolean } = {}
) {
  const { installations = INSTALLATIONS, artifactsEnabled = true, gitlabEnabled = false } = opts;
  await setupAuditRoutes(page, (path, respond) => {
    if (path.endsWith('/api/config/login-providers')) {
      return respond(200, { github: true, google: false, gitlab: gitlabEnabled });
    }
    if (path.endsWith('/api/github/installations')) return respond(200, installations);
    if (path.endsWith('/api/github/repositories')) {
      return respond(200, { repositories: [], failedInstallations: [] });
    }
    if (path.endsWith('/api/gitlab/projects')) return respond(200, { projects: GITLAB_PROJECTS });
    if (path.endsWith('/api/gitlab/branches')) {
      return respond(200, { branches: [{ name: 'main' }, { name: 'feature/agent-ready' }] });
    }
    if (path.endsWith('/api/config/artifacts-enabled'))
      return respond(200, { enabled: artifactsEnabled });
    if (path.endsWith('/api/agents')) return respond(200, { agents: AGENTS });
    if (path.endsWith('/api/credentials'))
      return respond(200, [{ provider: 'hetzner', status: 'valid' }]);
    if (path.endsWith('/api/trial/status')) return respond(200, { available: false });
    // App-shell surfaces that load on every authed page.
    if (path.endsWith('/api/projects'))
      return respond(200, { projects: [], total: 0, hasMore: false });
    if (path.endsWith('/api/notifications'))
      return respond(200, { notifications: [], unreadCount: 0, hasMore: false });
    return undefined;
  });
  // Project creation (POST) — registered after the catch-all so it wins for /api/projects.
  await page.route('**/api/projects', (route) => {
    if (route.request().method() === 'POST') {
      const body = route.request().postDataJSON() as { repoProvider?: string } | null;
      return route.fulfill({
        status: 201,
        json:
          body?.repoProvider === 'gitlab'
            ? {
                ...CREATED_PROJECT,
                repository:
                  'platform-experiments/a-very-long-gitlab-project-name-that-wraps-cleanly',
                repoProvider: 'gitlab',
              }
            : CREATED_PROJECT,
      });
    }
    return route.fulfill({ status: 200, json: { projects: [], total: 0, hasMore: false } });
  });
  // Register auth last so it wins over the catch-all (last route registered wins).
  await page.route('**/api/auth/get-session', (route) =>
    route.fulfill({ status: 200, json: MOCK_USER })
  );
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

  test('captures the GitLab provider and project selection path', async ({ page }) => {
    await setupMocks(page, { gitlabEnabled: true });
    await gotoWizard(page);

    await page.getByRole('button', { name: /Get started/ }).click();
    await page.getByRole('button', { name: /Continue/ }).click();
    await expect(page.getByRole('heading', { name: /Where should your code live/ })).toBeVisible();
    await expect(page.getByText('Connect a GitLab project')).toBeVisible();
    await screenshot(page, 'onboarding-gitlab-01-provider');
    await assertNoOverflow(page);

    await page.getByText('Connect a GitLab project').click();
    await page.getByRole('button', { name: /Continue/ }).click();
    await expect(page.getByRole('heading', { name: 'Connect your code' })).toBeVisible();
    await page.getByLabel('GitLab project').fill('platform-experiments');
    await expect(
      page.getByText('platform-experiments/a-very-long-gitlab-project-name-that-wraps-cleanly')
    ).toBeVisible();
    await screenshot(page, 'onboarding-gitlab-02-project-list');
    await assertNoOverflow(page);

    await page
      .getByText('platform-experiments/a-very-long-gitlab-project-name-that-wraps-cleanly')
      .click();
    await expect(page.getByPlaceholder('Project name')).toHaveValue(
      'a-very-long-gitlab-project-name-that-wraps-cleanly'
    );
    await screenshot(page, 'onboarding-gitlab-03-selected-project');
    await assertNoOverflow(page);
  });

  test('setup steps show Create/Skip in the footer (not inside the card)', async ({ page }) => {
    await setupMocks(page);
    await gotoWizard(page);

    // Fast-path to the conversation step via the SAM provider.
    await page.getByRole('button', { name: /Get started/ }).click();
    await page.getByRole('button', { name: /Continue/ }).click();
    await page.getByText('Let SAM host the repository').click();
    await page.getByRole('button', { name: /Continue/ }).click();
    await page.getByPlaceholder('Project name').fill('greenfield');
    await page.getByRole('button', { name: /Create project/ }).click();

    // Conversation step: footer has Skip + Create profile; the card has no buttons.
    await expect(page.getByRole('heading', { name: 'Set up a conversation agent' })).toBeVisible();
    const nav = page.getByRole('navigation', { name: 'Step navigation' });
    await expect(nav.getByRole('button', { name: /Create profile/ })).toBeVisible();
    await expect(nav.getByRole('button', { name: /^Skip$/ })).toBeVisible();
    await screenshot(page, 'onboarding-05-conversation');
    await assertNoOverflow(page);

    // Automation step footer: Create trigger + Skip.
    await nav.getByRole('button', { name: /^Skip$/ }).click();
    await expect(page.getByRole('heading', { name: 'Set up a task agent' })).toBeVisible();
    await nav.getByRole('button', { name: /^Skip$/ }).click();
    await expect(page.getByRole('heading', { name: /Schedule automation/ })).toBeVisible();
    await expect(nav.getByRole('button', { name: /Create trigger/ })).toBeVisible();
    await screenshot(page, 'onboarding-06-automation');
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
