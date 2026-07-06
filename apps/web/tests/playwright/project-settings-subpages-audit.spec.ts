import { expect, type Page, test } from '@playwright/test';

import { assertNoOverflow, makeMockUser, screenshot, setupAuditRoutes } from './audit-helpers';

const PROJECT_ID = 'proj-settings-1';

const MOCK_USER = makeMockUser({
  userId: 'owner-user',
  sessionId: 'session-project-settings',
  email: 'owner@example.com',
  name: 'Owner User',
  role: 'user',
});

const project = {
  id: PROJECT_ID,
  name:
    'Project With A Very Long Name For Settings Navigation And Mobile Header Wrapping Validation',
  repository: 'acme/extremely-long-project-settings-repository-name-that-should-not-overflow',
  repoProvider: 'github',
  defaultBranch: 'main',
  userId: 'owner-user',
  installationId: 'inst-1',
  defaultVmSize: null,
  defaultAgentType: null,
  defaultProvider: null,
  defaultLocation: null,
  workspaceIdleTimeoutMs: null,
  nodeIdleTimeoutMs: null,
  taskExecutionTimeoutMs: null,
  maxConcurrentTasks: null,
  maxDispatchDepth: null,
  maxSubTasksPerTask: null,
  warmNodeTimeoutMs: null,
  maxWorkspacesPerNode: null,
  nodeCpuThresholdPercent: null,
  nodeMemoryThresholdPercent: null,
  createdAt: '2026-07-06T00:00:00.000Z',
  updatedAt: '2026-07-06T00:00:00.000Z',
  summary: {
    activeWorkspaceCount: 0,
    activeSessionCount: 0,
    lastActivityAt: null,
    taskCountsByStatus: {},
    linkedWorkspaces: 0,
  },
};

const members = {
  members: [
    {
      projectId: PROJECT_ID,
      userId: 'owner-user',
      role: 'owner',
      status: 'active',
      invitedBy: null,
      createdAt: '2026-07-06T00:00:00.000Z',
      updatedAt: '2026-07-06T00:00:00.000Z',
      user: {
        id: 'owner-user',
        name: 'Owner User',
        email: 'owner@example.com',
        image: null,
        avatarUrl: null,
      },
    },
    {
      projectId: PROJECT_ID,
      userId: 'admin-user',
      role: 'admin',
      status: 'active',
      invitedBy: 'owner-user',
      createdAt: '2026-07-06T00:00:00.000Z',
      updatedAt: '2026-07-06T00:00:00.000Z',
      user: {
        id: 'admin-user',
        name: 'Collaborator With A Very Long Name That Should Truncate In Member Rows',
        email: 'collaborator.with.a.very.long.email.address+settings@example-subdomain.example.com',
        image: null,
        avatarUrl: null,
      },
    },
  ],
  inviteLinks: [
    {
      id: 'invite-1',
      projectId: PROJECT_ID,
      status: 'active',
      expiresAt: '2099-01-01T00:00:00.000Z',
      revokedAt: null,
      createdBy: 'owner-user',
      createdAt: '2026-07-06T00:00:00.000Z',
      updatedAt: '2026-07-06T00:00:00.000Z',
      lastUsedAt: '2026-07-06T00:10:00.000Z',
      useCount: 2,
    },
  ],
  accessRequests: [
    {
      id: 'request-1',
      projectId: PROJECT_ID,
      inviteLinkId: 'invite-1',
      requesterUserId: 'requester-user',
      status: 'pending',
      githubAccessStatus: 'no-access',
      githubAccessCheckedAt: '2026-07-06T00:00:00.000Z',
      githubAccessMessage:
        'Requester does not have GitHub access to the project repository with a long explanatory message that must wrap cleanly.',
      requestedAt: '2026-07-06T00:00:00.000Z',
      decidedAt: null,
      decidedBy: null,
      decisionNote: null,
      createdAt: '2026-07-06T00:00:00.000Z',
      updatedAt: '2026-07-06T00:00:00.000Z',
      requester: {
        id: 'requester-user',
        name: 'Requester With Long Display Name',
        email: 'requester.with.long.email@example-subdomain.example.com',
        image: null,
        avatarUrl: null,
      },
    },
  ],
};

const emptyCredentialHealth = {
  projectId: PROJECT_ID,
  multiplayerActive: true,
  counts: {
    resources: 0,
    personalResources: 0,
    personalCredentials: 0,
    projectCoveredCredentials: 0,
    unknownCredentials: 0,
  },
  resources: [],
};

async function setupMocks(page: Page) {
  await page.addInitScript(() =>
    localStorage.setItem('sam-onboarding-wizard-dismissed-owner-user', 'true')
  );

  await setupAuditRoutes(page, (path, respond) => {
    if (path.startsWith('/api/auth/')) return respond(200, MOCK_USER);
    if (path === '/api/projects') return respond(200, { projects: [project] });
    if (path === '/api/agents') return respond(200, { agents: [] });
    if (path === '/api/dashboard/active-tasks') return respond(200, { tasks: [] });
    if (path === '/api/providers/catalog') return respond(200, { catalogs: [] });
    if (path.startsWith('/api/notifications')) {
      return respond(200, { notifications: [], unreadCount: 0 });
    }
    if (path.startsWith('/api/github')) return respond(200, []);
    if (path.startsWith('/api/nodes')) return respond(200, { nodes: [] });
    if (path === '/api/credentials/resolution-status') return respond(200, { consumers: [] });
    if (path.startsWith('/api/credentials')) return respond(200, []);

    const projectMatch = path.match(/^\/api\/projects\/([^/]+)(\/.*)?$/);
    if (projectMatch) {
      const subPath = projectMatch[2] ?? '';
      if (!subPath) return respond(200, project);
      if (subPath === '/repository-access') {
        return respond(200, {
          primaryRepository: project.repository,
          repositories: [
            {
              id: 'repo-1',
              projectId: PROJECT_ID,
              repository:
                'acme/long-additional-repository-name-used-to-confirm-access-tab-wrapping',
              status: 'active',
              createdAt: '2026-07-06T00:00:00.000Z',
              updatedAt: '2026-07-06T00:00:00.000Z',
            },
          ],
        });
      }
      if (subPath === '/repository-access/available') {
        return respond(200, { repositories: [] });
      }
      if (subPath === '/repository-access/discover') {
        return respond(200, { suggestions: [] });
      }
      if (subPath === '/members') return respond(200, members);
      if (subPath === '/credential-attribution-health') {
        return respond(200, emptyCredentialHealth);
      }
      if (subPath === '/runtime-config') return respond(200, { envVars: [], files: [] });
      if (subPath.startsWith('/agent-profiles')) return respond(200, []);
      if (subPath === '/credentials') return respond(200, { credentials: [] });
      if (subPath.startsWith('/deployment')) return respond(404, { error: 'Not found' });
      return respond(200, project);
    }

    return undefined;
  });
}

async function expectCompactTabs(page: Page) {
  const tablist = page.getByRole('tablist');
  await expect(tablist).toBeVisible();
  const metrics = await tablist.evaluate((element) => ({
    height: element.getBoundingClientRect().height,
    tabCount: element.querySelectorAll('[role="tab"]').length,
  }));
  expect(metrics.tabCount).toBe(7);
  expect(metrics.height).toBeLessThanOrEqual(56);
}

test.describe('Project settings sub-pages', () => {
  test.beforeEach(async ({ page }) => {
    await setupMocks(page);
  });

  test('default route redirects to General and tab shell remains compact', async ({ page }) => {
    await page.goto(`/projects/${PROJECT_ID}/settings`);
    await expect(page).toHaveURL(new RegExp(`/projects/${PROJECT_ID}/settings/general$`));
    await expect(page.getByRole('heading', { name: 'Project Settings' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Project Name' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Danger Zone' })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'General' })).toHaveAttribute(
      'aria-selected',
      'true'
    );
    await expectCompactTabs(page);
    await screenshot(page, 'project-settings-general');
    await assertNoOverflow(page);
  });

  test('Access sub-page keeps members and invite controls discoverable', async ({ page }) => {
    await page.goto(`/projects/${PROJECT_ID}/settings/access`);
    await expect(page.getByRole('heading', { name: 'Repository Access' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Members', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Current Members' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Invite Link' })).toBeVisible();
    await expect(page.getByRole('button', { name: /new link/i })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Access' })).toHaveAttribute(
      'aria-selected',
      'true'
    );
    await expectCompactTabs(page);
    await screenshot(page, 'project-settings-access');
    await assertNoOverflow(page);

    await page.getByRole('heading', { name: 'Invite Link' }).scrollIntoViewIfNeeded();
    await screenshot(page, 'project-settings-access-invite');
    await assertNoOverflow(page);
  });
});
