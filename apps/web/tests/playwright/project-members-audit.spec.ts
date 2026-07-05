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
  multiplayerActive: false,
  counts: {
    resources: 0,
    personalResources: 0,
    personalCredentials: 0,
    projectCoveredCredentials: 0,
    unknownCredentials: 0,
  },
  resources: [],
};

function offboardingResource(
  resourceKind: string,
  resourceId: string,
  title: string,
  overrides: Record<string, unknown> = {}
) {
  return {
    resourceKind,
    resourceId,
    title,
    subtitle: resourceKind === 'trigger' ? '0 9 * * *' : 'running',
    href:
      resourceKind === 'trigger'
        ? `/projects/${project.id}/triggers/${resourceId}`
        : resourceKind === 'task_tree'
          ? `/projects/${project.id}/tasks/${resourceId}`
          : resourceKind === 'deployment_environment'
            ? `/projects/${project.id}/deployments/${resourceId}`
            : `/projects/${project.id}/workspaces/ws-${resourceId}`,
    credentialSourceBefore: 'user',
    attributionUserIdBefore: 'admin-user',
    attributionProjectIdBefore: project.id,
    recommendedAction: 'break_and_flag',
    availableActions: ['break_and_flag', 'defer_removal'],
    requiresHumanDecision: true,
    blocksRemoval: resourceKind === 'node' || resourceKind === 'deployment_environment',
    details: {
      status: resourceKind === 'task_tree' ? 'running' : 'active',
      remainingProjectCoverage: null,
    },
    ...overrides,
  };
}

const normalOffboardingPreview = {
  offboardingPlanId: 'off-normal',
  projectId: project.id,
  memberUserId: 'admin-user',
  canApply: false,
  requiresHumanDecision: true,
  summary: {
    breakAndFlag: 3,
    reattachAvailable: 1,
    blockingTeardown: 1,
  },
  resources: [
    offboardingResource('trigger', 'trigger-1', 'Daily repository review', {
      availableActions: ['reattach_to_project', 'break_and_flag', 'defer_removal'],
      details: {
        status: 'active',
        remainingProjectCoverage: {
          agent: { attachmentId: 'attach-agent', configurationId: 'config-agent' },
          compute: { attachmentId: 'attach-compute', configurationId: 'config-compute' },
        },
      },
    }),
    offboardingResource('task_tree', 'task-1', 'Running usage analysis'),
    offboardingResource('node', 'node-1', 'Workspace node for feature branch'),
    offboardingResource('deployment_environment', 'deploy-1', 'Production deployment'),
  ],
};

const longOffboardingPreview = {
  ...normalOffboardingPreview,
  offboardingPlanId: 'off-long',
  resources: [
    offboardingResource(
      'trigger',
      'trigger-long',
      'Extremely long scheduled workflow name that should wrap cleanly without forcing the offboarding modal wider than the viewport or hiding the action selector from the reviewer',
      {
        subtitle:
          'This trigger description includes a very long branch and repository context with repeated qualifiers, punctuation, and URL-like text https://example.com/acme/shared-project/actions/really-long-path-for-layout-testing',
        availableActions: ['reattach_to_project', 'break_and_flag', 'defer_removal'],
        details: {
          status: 'active',
          remainingProjectCoverage: {
            agent: { attachmentId: 'attach-agent', configurationId: 'config-agent' },
          },
        },
      }
    ),
    offboardingResource(
      'node',
      'node-long',
      'deployment-node-with-a-very-long-provider-generated-name-and-region-fr-par-1-that-must-wrap',
      {
        subtitle:
          'workspace-with-super-long-branch-name/feature/shared-project-offboarding-and-credential-attribution-cleanup',
      }
    ),
  ],
};

const emptyOffboardingPreview = {
  offboardingPlanId: 'off-empty',
  projectId: project.id,
  memberUserId: 'admin-user',
  canApply: true,
  requiresHumanDecision: false,
  summary: {
    breakAndFlag: 0,
    reattachAvailable: 0,
    blockingTeardown: 0,
  },
  resources: [],
};

const manyOffboardingPreview = {
  ...normalOffboardingPreview,
  offboardingPlanId: 'off-many',
  resources: Array.from({ length: 18 }, (_, index) => {
    const kinds = ['trigger', 'task_tree', 'node', 'deployment_environment'];
    const kind = kinds[index % kinds.length]!;
    return offboardingResource(kind, `${kind}-${index + 1}`, `${kind.replace('_', ' ')} ${index + 1}`);
  }),
};

async function setupMocks(
  page: Page,
  options: {
    applyError?: 'stale_plan' | 'expired_plan';
    offboardingPreview?: typeof normalOffboardingPreview;
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
      if (subPath === '/members/admin-user/offboarding-preview') {
        return respond(200, options.offboardingPreview ?? normalOffboardingPreview);
      }
      if (subPath === '/members/admin-user/offboarding-apply') {
        if (options.applyError) {
          return respond(409, {
            error: options.applyError,
            message:
              options.applyError === 'stale_plan'
                ? 'The offboarding plan is stale.'
                : 'The offboarding plan expired.',
          });
        }
        return respond(200, {
          projectId: project.id,
          memberUserId: 'admin-user',
          status: 'removed',
          appliedAt: '2026-07-04T00:20:00.000Z',
          resourceResults: [],
        });
      }
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

async function openRemoveMember(page: Page) {
  await goToMembers(page);
  await page.getByRole('button', { name: 'Remove member' }).click();
  await expect(page.getByRole('dialog', { name: /Remove member/i })).toBeVisible();
}

async function submitOffboardingModal(page: Page) {
  const dialog = page.getByRole('dialog', { name: /Remove member/i });
  await expect(dialog.getByText('Running tasks')).toBeVisible();
  await dialog.getByRole('button', { name: /^Remove member$/ }).click();
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

  test('offboarding modal with mixed resources', async ({ page }) => {
    await setupMocks(page, { offboardingPreview: normalOffboardingPreview });
    await openRemoveMember(page);
    await expect(page.getByText('Running tasks')).toBeVisible();
    await screenshot(page, 'project-members-offboarding-normal');
    await assertNoOverflow(page);
  });

  test('offboarding modal long text wraps', async ({ page }) => {
    await setupMocks(page, { offboardingPreview: longOffboardingPreview });
    await openRemoveMember(page);
    await expect(page.getByText(/Extremely long scheduled workflow name/)).toBeVisible();
    await screenshot(page, 'project-members-offboarding-long-text');
    await assertNoOverflow(page);
  });

  test('offboarding modal clean removal empty state', async ({ page }) => {
    await setupMocks(page, { offboardingPreview: emptyOffboardingPreview });
    await openRemoveMember(page);
    await expect(page.getByText(/removed cleanly/i)).toBeVisible();
    await screenshot(page, 'project-members-offboarding-empty');
    await assertNoOverflow(page);
  });

  test('offboarding modal many resources scrolls without overflow', async ({ page }) => {
    await setupMocks(page, { offboardingPreview: manyOffboardingPreview });
    await openRemoveMember(page);
    await expect(page.getByText('trigger 17')).toBeVisible();
    await screenshot(page, 'project-members-offboarding-many');
    await assertNoOverflow(page);
  });

  test('offboarding stale plan error state', async ({ page }) => {
    await setupMocks(page, {
      offboardingPreview: normalOffboardingPreview,
      applyError: 'stale_plan',
    });
    await openRemoveMember(page);
    await submitOffboardingModal(page);
    await expect(page.getByText(/project changed after this preview/i)).toBeVisible();
    await screenshot(page, 'project-members-offboarding-stale-plan');
    await assertNoOverflow(page);
  });

  test('offboarding expired plan error state', async ({ page }) => {
    await setupMocks(page, {
      offboardingPreview: normalOffboardingPreview,
      applyError: 'expired_plan',
    });
    await openRemoveMember(page);
    await submitOffboardingModal(page);
    await expect(page.getByText(/preview expired/i)).toBeVisible();
    await screenshot(page, 'project-members-offboarding-expired-plan');
    await assertNoOverflow(page);
  });
});
