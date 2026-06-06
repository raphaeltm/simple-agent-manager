import { expect, type Page, type Route, test } from '@playwright/test';

const MOCK_USER = {
  user: {
    id: 'user-1',
    email: 'test@example.com',
    name: 'Test User',
    image: null,
    role: 'user',
    status: 'active',
    emailVerified: true,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  },
  session: {
    id: 'session-1',
    userId: 'user-1',
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
    token: 'mock-token',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  },
};

const INSTALLATION = {
  id: 'inst-1',
  userId: 'user-1',
  installationId: '1001',
  accountName: 'acme',
  accountType: 'organization',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

const LONG_REPO_NAME =
  'acme/sam-project-onboarding-visual-audit-with-a-very-long-repository-name-and-special-chars';

function makeAgents(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    id: index % 2 === 0 ? 'codex' : 'opencode',
    name: `Configured Agent ${index + 1} with a deliberately long display name`,
    description: 'Configured test agent',
    supportsAcp: true,
    configured: true,
    credentialHelpUrl: 'https://example.com',
    fallbackCredentialSource: null,
  }));
}

async function setupMocks(
  page: Page,
  options: {
    installations?: typeof INSTALLATION[];
    agents?: unknown[];
    projectStatus?: number;
    triggerStatus?: number;
    submitStatus?: number;
  } = {},
) {
  const {
    installations = [INSTALLATION],
    agents = makeAgents(8),
    projectStatus = 201,
    triggerStatus = 200,
    submitStatus = 403,
  } = options;

  await page.route('**/api/**', async (route: Route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const method = route.request().method();
    const respond = (status: number, body: unknown) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

    if (path.includes('/api/auth/')) return respond(200, MOCK_USER);
    if (path === '/api/github/installations') return respond(200, installations);
    if (path.startsWith('/api/github/repositories')) {
      return respond(200, {
        repositories: [
          {
            id: 101,
            fullName: LONG_REPO_NAME,
            name: LONG_REPO_NAME.split('/')[1],
            private: true,
            defaultBranch: 'main',
            installationId: 'inst-1',
          },
        ],
        total: 1,
      });
    }
    if (path.startsWith('/api/github/branches')) {
      return respond(200, [{ name: 'main' }, { name: 'feature/project-onboarding-long-branch-name' }]);
    }
    if (path === '/api/agents') return respond(200, { agents });
    if (path === '/api/projects' && method === 'GET') {
      return respond(200, { projects: [], nextCursor: null });
    }
    if (path === '/api/projects' && method === 'POST') {
      if (projectStatus !== 201) {
        return respond(projectStatus, { error: 'CONFLICT', message: 'Project name must be unique per user' });
      }
      return respond(201, {
        id: 'proj-1',
        userId: 'user-1',
        name: 'project-onboarding',
        description: null,
        installationId: 'inst-1',
        repository: LONG_REPO_NAME,
        defaultBranch: 'main',
        status: 'active',
        activeWorkspaceCount: 0,
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      });
    }
    if (path === '/api/projects/proj-1/agent-profiles' && method === 'POST') {
      return respond(200, {
        id: route.request().postDataJSON().taskMode === 'task' ? 'task-profile' : 'conversation-profile',
        name: route.request().postDataJSON().name,
        taskMode: route.request().postDataJSON().taskMode,
      });
    }
    if (path === '/api/projects/proj-1/triggers' && method === 'POST') {
      if (triggerStatus !== 200) {
        return respond(triggerStatus, { error: 'CONFLICT', message: 'Trigger "Daily" already exists in this project' });
      }
      return respond(200, { id: 'trigger-1' });
    }
    if (path === '/api/projects/proj-1/tasks/submit' && method === 'POST') {
      if (submitStatus !== 200) {
        return respond(submitStatus, { error: 'FORBIDDEN', message: 'Cloud credentials are required' });
      }
      return respond(200, { taskId: 'task-1', sessionId: 'session-1', branchName: 'sam/task-1', status: 'queued' });
    }
    if (path.startsWith('/api/notifications')) return respond(200, { notifications: [], unreadCount: 0 });
    if (path === '/api/dashboard/active-tasks') return respond(200, { tasks: [] });
    return respond(200, {});
  });
}

async function assertNoOverflow(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  expect(overflow).toBe(false);
}

async function screenshot(page: Page, name: string) {
  await page.waitForTimeout(600);
  await page.screenshot({
    path: `../../.codex/tmp/playwright-screenshots/${name}.png`,
    fullPage: true,
  });
}

async function openWizard(page: Page) {
  await page.goto('/projects/new');
  await page.getByPlaceholder('https://github.com/user/repo or select from list').waitFor({ timeout: 10000 });
}

async function createProject(page: Page) {
  await page.getByPlaceholder('https://github.com/user/repo or select from list').click();
  await page.getByText(LONG_REPO_NAME).click();
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.getByText('Set up project-onboarding').waitFor({ timeout: 10000 });
}

async function reachKickoffWithSkippedSetup(page: Page) {
  await createProject(page);
  await page.getByRole('button', { name: 'Skip profile' }).first().click();
  await page.getByRole('button', { name: 'Skip profile' }).first().click();
  await page.getByRole('button', { name: 'Skip trigger' }).click();
  await page.getByRole('button', { name: /Continue/ }).click();
  await page.getByText('Kick off work').waitFor();
}

test.describe('Project onboarding wizard - Mobile', () => {
  test('connect step handles long repository names', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'iPhone SE (375x667)', 'mobile-only audit scenario');
    await setupMocks(page);
    await openWizard(page);
    await page.getByPlaceholder('https://github.com/user/repo or select from list').click();
    await page.getByText(LONG_REPO_NAME).click();

    await assertNoOverflow(page);
    await screenshot(page, 'project-onboarding-connect-long-mobile');
  });

  test('setup step with many configured agents', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'iPhone SE (375x667)', 'mobile-only audit scenario');
    await setupMocks(page, { agents: makeAgents(30) });
    await openWizard(page);
    await createProject(page);

    await assertNoOverflow(page);
    await screenshot(page, 'project-onboarding-setup-many-agents-mobile');
  });

  test('kickoff credential error renders cleanly', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'iPhone SE (375x667)', 'mobile-only audit scenario');
    await setupMocks(page, { submitStatus: 403 });
    await openWizard(page);
    await reachKickoffWithSkippedSetup(page);
    await page.getByRole('button', { name: 'Start task' }).click();
    await page.getByText('Cloud credentials are required before SAM can start a task or conversation for this project.').waitFor();

    await assertNoOverflow(page);
    await screenshot(page, 'project-onboarding-kickoff-credential-error-mobile');
  });

  test('empty installation state', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'iPhone SE (375x667)', 'mobile-only audit scenario');
    await setupMocks(page, { installations: [] });
    await page.goto('/projects/new');
    await page.getByText('Install the GitHub App in Settings before creating a project from a repository.').waitFor();

    await assertNoOverflow(page);
    await screenshot(page, 'project-onboarding-empty-installations-mobile');
  });
});

test.describe('Project onboarding wizard - Desktop', () => {
  test.use({ viewport: { width: 1280, height: 800 }, isMobile: false, hasTouch: false });

  test('connect step desktop layout', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'Desktop (1280x800)', 'desktop-only audit scenario');
    await setupMocks(page);
    await openWizard(page);

    await assertNoOverflow(page);
    await screenshot(page, 'project-onboarding-connect-desktop');
  });

  test('setup and trigger conflict desktop layout', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'Desktop (1280x800)', 'desktop-only audit scenario');
    await setupMocks(page, { triggerStatus: 409 });
    await openWizard(page);
    await createProject(page);
    await page.getByRole('button', { name: 'Create trigger' }).click();
    await page.getByText('A trigger with this name already exists in this project.').waitFor();

    await assertNoOverflow(page);
    await screenshot(page, 'project-onboarding-trigger-conflict-desktop');
  });
});
