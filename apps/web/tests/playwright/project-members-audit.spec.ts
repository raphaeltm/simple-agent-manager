import { expect, type Page, test } from '@playwright/test';

import { assertNoOverflow, makeMockUser, screenshot, setupAuditRoutes } from './audit-helpers';

const MOCK_USER = makeMockUser({
  userId: 'owner-user',
  sessionId: 'session-members',
  email: 'owner@example.com',
  name: 'Owner User',
  role: 'user',
});

function makeProject(overrides: Record<string, unknown> = {}) {
  return {
    id: 'proj-members-1',
    name: 'Shared Project',
    repository: 'acme/shared-project',
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
    createdAt: '2026-07-04T00:00:00.000Z',
    updatedAt: '2026-07-04T00:00:00.000Z',
    summary: {
      activeWorkspaceCount: 0,
      activeSessionCount: 0,
      lastActivityAt: null,
      taskCountsByStatus: {},
      linkedWorkspaces: 0,
    },
    ...overrides,
  };
}

const project = makeProject();

function member(userId: string, name: string, email: string, role: 'owner' | 'admin') {
  return {
    projectId: project.id,
    userId,
    role,
    status: 'active',
    invitedBy: role === 'owner' ? null : 'owner-user',
    createdAt: '2026-07-04T00:00:00.000Z',
    updatedAt: '2026-07-04T00:00:00.000Z',
    user: {
      id: userId,
      name,
      email,
      image: null,
      avatarUrl: null,
    },
  };
}

function accessRequest(id: string, status = 'verified') {
  return {
    id,
    projectId: project.id,
    inviteLinkId: 'invite-1',
    requesterUserId: `${id}-user`,
    status: 'pending',
    githubAccessStatus: status,
    githubAccessCheckedAt: '2026-07-04T00:00:00.000Z',
    githubAccessMessage:
      status === 'no-access'
        ? 'Requester does not have GitHub access to the project repository.'
        : null,
    requestedAt: '2026-07-04T00:00:00.000Z',
    decidedAt: null,
    decidedBy: null,
    decisionNote: null,
    createdAt: '2026-07-04T00:00:00.000Z',
    updatedAt: '2026-07-04T00:00:00.000Z',
    requester: {
      id: `${id}-user`,
      name:
        id === 'long'
          ? 'Requester With A Very Long Display Name That Should Wrap Or Truncate Cleanly'
          : 'Requester',
      email:
        id === 'long'
          ? 'requester.with.a.very.long.email.address+sam-shared-project-access@example-subdomain.example.com'
          : 'requester@example.com',
      image: null,
      avatarUrl: null,
    },
  };
}

const normalMembers = {
  members: [
    member('owner-user', 'Owner User', 'owner@example.com', 'owner'),
    member('admin-user', 'Admin User', 'admin@example.com', 'admin'),
  ],
  inviteLinks: [
    {
      id: 'invite-1',
      projectId: project.id,
      status: 'active',
      expiresAt: '2099-01-01T00:00:00.000Z',
      revokedAt: null,
      createdBy: 'owner-user',
      createdAt: '2026-07-04T00:00:00.000Z',
      updatedAt: '2026-07-04T00:00:00.000Z',
      lastUsedAt: '2026-07-04T00:10:00.000Z',
      useCount: 2,
    },
  ],
  accessRequests: [accessRequest('normal'), accessRequest('long', 'no-access')],
};

const emptyMembers = {
  members: [member('owner-user', 'Owner User', 'owner@example.com', 'owner')],
  inviteLinks: [],
  accessRequests: [],
};

const emptyCredentialHealth = {
  projectId: project.id,
  counts: {
    resources: 0,
    personalResources: 0,
    personalCredentials: 0,
    projectCoveredCredentials: 0,
    unknownCredentials: 0,
  },
  resources: [],
};

async function setupMocks(
  page: Page,
  options: {
    members?: typeof normalMembers;
    inviteStatus?: 'active' | 'expired' | 'revoked';
    inviteMembershipStatus?: string;
  } = {}
) {
  const members = options.members ?? normalMembers;

  await page.addInitScript(() =>
    localStorage.setItem('sam-onboarding-wizard-dismissed-owner-user', 'true')
  );

  await setupAuditRoutes(page, (path, respond) => {
    if (path.startsWith('/api/auth/')) return respond(200, MOCK_USER);
    if (path === '/api/projects') return respond(200, { projects: [project] });
    if (path === '/api/agents') return respond(200, { agents: [] });
    if (path === '/api/dashboard/active-tasks') return respond(200, { tasks: [] });
    if (path === '/api/providers/catalog') return respond(200, { catalogs: [] });
    if (path.startsWith('/api/notifications')) return respond(200, { notifications: [], unreadCount: 0 });
    if (path.startsWith('/api/github')) return respond(200, []);
    if (path === '/api/credentials/resolution-status') return respond(200, { consumers: [] });
    if (path === '/api/credentials/agent') return respond(200, { credentials: [] });
    if (path.startsWith('/api/credentials')) return respond(200, []);
    if (path.startsWith('/api/nodes')) return respond(200, { nodes: [] });

    if (path === '/api/projects/invite-links/sam_inv_preview') {
      return respond(200, {
        token: 'sam_inv_preview',
        status: options.inviteStatus ?? 'active',
        expiresAt: '2099-01-01T00:00:00.000Z',
        project: {
          id: project.id,
          name: project.name,
          repository: project.repository,
          repoProvider: 'github',
        },
        membershipStatus: options.inviteMembershipStatus ?? 'can-request',
        accessRequest: null,
      });
    }
    if (path === '/api/projects/invite-links/sam_inv_preview/request') {
      return respond(201, accessRequest('normal'));
    }

    const projectMatch = path.match(/^\/api\/projects\/([^/]+)(\/.*)?$/);
    if (projectMatch) {
      const subPath = projectMatch[2] ?? '';
      if (subPath === '/members') return respond(200, members);
      if (subPath === '/credential-attribution-health') return respond(200, emptyCredentialHealth);
      if (subPath === '/runtime-config') return respond(200, { envVars: [], files: [] });
      if (subPath === '/repository-access') {
        return respond(200, { primaryRepository: project.repository, repositories: [] });
      }
      if (subPath === '/repository-access/available') return respond(200, { repositories: [] });
      if (subPath === '/repository-access/discover') return respond(200, { suggestions: [] });
      if (subPath.startsWith('/agent-profiles')) return respond(200, []);
      if (subPath === '/credentials') return respond(200, { credentials: [] });
      return respond(200, project);
    }

    return undefined;
  });
}

async function goToMembers(page: Page) {
  await page.goto('/projects/proj-members-1/settings');
  const heading = page.getByRole('heading', { name: 'Members', exact: true });
  await expect(heading).toBeVisible({ timeout: 12000 });
  await heading.scrollIntoViewIfNeeded();
}

test.describe('Project members settings — visual audit', () => {
  test('normal members and pending requests', async ({ page }) => {
    await setupMocks(page);
    await goToMembers(page);
    await expect(page.getByText('Pending Requests')).toBeVisible();
    await screenshot(page, 'project-members-normal');
    await assertNoOverflow(page);
  });

  test('empty requests and no active link', async ({ page }) => {
    await setupMocks(page, { members: emptyMembers });
    await goToMembers(page);
    await expect(page.getByText('No pending requests.')).toBeVisible();
    await screenshot(page, 'project-members-empty');
    await assertNoOverflow(page);
  });

  test('invite recipient page', async ({ page }) => {
    await setupMocks(page);
    await page.goto('/projects/invite/sam_inv_preview');
    await expect(page.getByRole('button', { name: 'Request Access' })).toBeVisible();
    await screenshot(page, 'project-invite-request');
    await assertNoOverflow(page);
  });
});
