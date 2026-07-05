import { expect, type Page, test, type TestInfo } from '@playwright/test';

import { assertNoOverflow, makeMockUser, screenshot, setupAuditRoutes } from './audit-helpers';

const PROJECT_ID = 'proj-credential-health';

const MOCK_USER = makeMockUser({
  userId: 'owner-user',
  sessionId: 'session-credential-health',
  email: 'owner@example.com',
  name: 'Owner User',
});

const project = {
  id: PROJECT_ID,
  name: 'Credential Health Project',
  repository: 'acme/credential-health-project',
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
  multiplayerActive: true,
  summary: {
    activeWorkspaceCount: 0,
    activeSessionCount: 0,
    lastActivityAt: null,
    taskCountsByStatus: {},
    linkedWorkspaces: 0,
  },
};

const coworker = {
  id: 'coworker-user',
  name: 'Coworker With A Very Long Display Name That Should Wrap Cleanly',
  email: 'coworker.with.long.address+credentials@example-subdomain.example.com',
  avatarUrl: null,
};

function makeTrigger(overrides: Record<string, unknown> = {}) {
  return {
    id: 'trigger-credential-health',
    projectId: PROJECT_ID,
    userId: coworker.id,
    name: 'Daily credential-backed review',
    description: 'Runs every morning on the project shared trigger schedule.',
    status: 'active',
    sourceType: 'cron',
    cronExpression: '0 9 * * *',
    cronHumanReadable: 'Daily at 9:00 AM',
    cronTimezone: 'UTC',
    skipIfRunning: true,
    promptTemplate: 'Review open pull requests',
    agentProfileId: null,
    taskMode: 'task',
    vmSizeOverride: null,
    maxConcurrent: 1,
    triggerCount: 8,
    nextFireAt: '2026-07-05T09:00:00.000Z',
    lastTriggeredAt: '2026-07-04T09:00:00.000Z',
    createdAt: '2026-07-04T00:00:00.000Z',
    updatedAt: '2026-07-04T00:00:00.000Z',
    credentialAttribution: {
      multiplayerActive: true,
      hasPersonalWarning: true,
      checks: [
        {
          consumerKind: 'agent',
          consumerTarget: 'opencode',
          label: 'Agent credential (opencode)',
          source: 'personal',
          owner: coworker,
          projectCredential: null,
          fixHref: `/projects/${PROJECT_ID}/settings`,
          warning: "This runs on Coworker's personal key.",
        },
        {
          consumerKind: 'compute',
          consumerTarget: 'inherited-provider',
          label: 'Compute credential (inherited-provider)',
          source: 'personal',
          owner: coworker,
          projectCredential: null,
          fixHref: `/projects/${PROJECT_ID}/settings`,
          warning: "This runs on Coworker's personal key.",
        },
      ],
    },
    ...overrides,
  };
}

const trigger = makeTrigger();

const longTrigger = makeTrigger({
  id: 'trigger-long',
  name: 'Credential-backed trigger with a 200 character name used to confirm compact navigation badges, detail modal rows, and inline trigger warnings all wrap without forcing horizontal scrolling or clipping on mobile viewports',
  description:
    'Unicode and escaped content: 日本語テスト 🚀 & <script>alert("xss")</script> with a long URL https://example.com/path/that/should/wrap/cleanly/in/the/detail/surface',
});

function makeResource(resourceTrigger = trigger) {
  return {
    id: resourceTrigger.id,
    projectId: PROJECT_ID,
    kind: 'trigger',
    title: resourceTrigger.name,
    subtitle: resourceTrigger.cronExpression,
    href: `/projects/${PROJECT_ID}/triggers/${resourceTrigger.id}`,
    createdBy: coworker,
    checks: resourceTrigger.credentialAttribution.checks,
  };
}

const credentialHealth = {
  projectId: PROJECT_ID,
  multiplayerActive: true,
  counts: {
    resources: 2,
    personalResources: 2,
    personalCredentials: 3,
    projectCoveredCredentials: 1,
    unknownCredentials: 0,
  },
  resources: [
    makeResource(trigger),
    {
      ...makeResource(longTrigger),
      checks: [
        longTrigger.credentialAttribution.checks[0],
        {
          consumerKind: 'compute',
          consumerTarget: 'hetzner',
          label: 'Compute credential (hetzner)',
          source: 'project',
          owner: coworker,
          projectCredential: {
            configurationId: 'cfg-compute',
            configurationName: 'Project Compute Credential With A Long But Non-Secret Label',
            credentialId: 'cred-compute',
            credentialName: 'Shared Hetzner key',
            owner: coworker,
          },
          fixHref: `/projects/${PROJECT_ID}/settings`,
          warning: null,
        },
      ],
    },
  ],
};

const emptyHealth = {
  projectId: PROJECT_ID,
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

function member(userId: string, name: string, email: string, role: 'owner' | 'admin') {
  return {
    projectId: PROJECT_ID,
    userId,
    role,
    status: 'active',
    invitedBy: role === 'owner' ? null : 'owner-user',
    createdAt: '2026-07-04T00:00:00.000Z',
    updatedAt: '2026-07-04T00:00:00.000Z',
    user: { id: userId, name, email, image: null, avatarUrl: null },
  };
}

const members = {
  members: [
    member('owner-user', 'Owner User', 'owner@example.com', 'owner'),
    member(coworker.id, coworker.name, coworker.email, 'admin'),
  ],
  inviteLinks: [
    {
      id: 'invite-1',
      projectId: PROJECT_ID,
      status: 'active',
      expiresAt: '2099-01-01T00:00:00.000Z',
      revokedAt: null,
      createdBy: 'owner-user',
      createdAt: '2026-07-04T00:00:00.000Z',
      updatedAt: '2026-07-04T00:00:00.000Z',
      lastUsedAt: null,
      useCount: 0,
    },
  ],
  accessRequests: [],
};

async function setupMocks(
  page: Page,
  options: {
    health?: typeof credentialHealth | typeof emptyHealth;
    healthError?: boolean;
    multiplayerActive?: boolean;
  } = {}
) {
  const multiplayerActive = options.multiplayerActive ?? true;
  const health = {
    ...(options.health ?? credentialHealth),
    multiplayerActive,
  };
  const mockProject = {
    ...project,
    multiplayerActive,
  };
  const mockTrigger = {
    ...trigger,
    credentialAttribution: {
      ...trigger.credentialAttribution,
      multiplayerActive,
    },
  };
  const mockLongTrigger = {
    ...longTrigger,
    credentialAttribution: {
      ...longTrigger.credentialAttribution,
      multiplayerActive,
    },
  };

  await page.addInitScript(() =>
    localStorage.setItem('sam-onboarding-wizard-dismissed-owner-user', 'true')
  );

  await setupAuditRoutes(page, (path, respond) => {
    if (path.startsWith('/api/auth/')) return respond(200, MOCK_USER);
    if (path === '/api/projects') return respond(200, { projects: [mockProject] });
    if (path === '/api/agents') return respond(200, { agents: [] });
    if (path === '/api/dashboard/active-tasks') return respond(200, { tasks: [] });
    if (path === '/api/providers/catalog') return respond(200, { catalogs: [] });
    if (path.startsWith('/api/notifications')) return respond(200, { notifications: [], unreadCount: 0 });
    if (path.startsWith('/api/github')) return respond(200, []);
    if (path === '/api/credentials/resolution-status') return respond(200, { consumers: [] });
    if (path.startsWith('/api/credentials')) return respond(200, { credentials: [] });
    if (path.startsWith('/api/nodes')) return respond(200, { nodes: [] });

    const projectMatch = path.match(/^\/api\/projects\/([^/]+)(\/.*)?$/);
    if (projectMatch) {
      const subPath = projectMatch[2] ?? '';
      if (subPath === '') return respond(200, mockProject);
      if (subPath === '/credential-attribution-health') {
        return options.healthError
          ? respond(500, { error: 'INTERNAL_ERROR', message: 'Health unavailable' })
          : respond(200, health);
      }
      if (subPath === '/triggers') return respond(200, { triggers: [mockTrigger, mockLongTrigger] });
      if (subPath === `/triggers/${trigger.id}`) return respond(200, mockTrigger);
      if (subPath === `/triggers/${longTrigger.id}`) return respond(200, mockLongTrigger);
      if (subPath.match(/^\/triggers\/[^/]+\/executions/)) {
        return respond(200, { executions: [], nextCursor: null });
      }
      if (subPath === '/members') return respond(200, members);
      if (subPath === '/runtime-config') return respond(200, { envVars: [], files: [] });
      if (subPath === '/repository-access') {
        return respond(200, { primaryRepository: project.repository, repositories: [] });
      }
      if (subPath === '/repository-access/available') return respond(200, { repositories: [] });
      if (subPath === '/repository-access/discover') return respond(200, { suggestions: [] });
      if (subPath.startsWith('/agent-profiles')) return respond(200, { items: [] });
      if (subPath === '/credentials') return respond(200, { credentials: [] });
      return respond(200, mockProject);
    }

    return undefined;
  });
}

function requireProject(projectName: string, message: string) {
  return ({ page: _page }: { page: Page }, testInfo: TestInfo) => {
    test.skip(testInfo.project.name !== projectName, message);
  };
}

const mobileOnly = requireProject('iPhone SE (375x667)', 'mobile audit runs on iPhone SE only');
const desktopOnly = requireProject('Desktop (1280x800)', 'desktop audit runs on desktop project only');

test.describe('Credential attribution health — desktop', () => {
  test.beforeEach(desktopOnly);

  test('nav badge and modal handle long shared-resource attribution', async ({ page }) => {
    await setupMocks(page);
    await page.goto(`/projects/${PROJECT_ID}/triggers`);
    const badge = page.getByRole('button', { name: /credential attribution health/i });
    await expect(badge).toBeVisible();
    await badge.click();
    await expect(page.getByRole('dialog', { name: /credential attribution/i })).toBeVisible();
    await expect(page.getByText("This runs on Coworker's personal key.").first()).toBeVisible();
    await screenshot(page, 'credential-health-modal-desktop');
    await assertNoOverflow(page);
  });

  test('trigger detail repeats inline personal-key warning', async ({ page }) => {
    await setupMocks(page);
    await page.goto(`/projects/${PROJECT_ID}/triggers/${trigger.id}`);
    await expect(page.getByText('Personal credential attribution')).toBeVisible();
    await screenshot(page, 'credential-health-trigger-warning-desktop');
    await assertNoOverflow(page);
  });

  test('solo project hides credential nav and inline trigger warnings', async ({ page }) => {
    await setupMocks(page, { multiplayerActive: false });
    await page.goto(`/projects/${PROJECT_ID}/triggers/${trigger.id}`);
    await expect(page.getByRole('button', { name: /credential attribution health/i })).toHaveCount(0);
    await expect(page.getByText('Personal credential attribution')).toHaveCount(0);
    await expect(page.getByText("This runs on Coworker's personal key.")).toHaveCount(0);
    await screenshot(page, 'credential-health-solo-hidden-desktop');
    await assertNoOverflow(page);
  });

  test('member settings show non-blocking sharing checklist', async ({ page }) => {
    await setupMocks(page);
    await page.goto(`/projects/${PROJECT_ID}/settings`);
    await expect(page.getByText('Credential checklist before sharing')).toBeVisible();
    await expect(page.getByText('Invite and approval can continue.')).toBeVisible();
    await screenshot(page, 'credential-health-member-warning-desktop');
    await assertNoOverflow(page);
  });
});

test.describe('Credential attribution health — mobile', () => {
  test.beforeEach(mobileOnly);

  test('drawer badge and modal remain usable on narrow screens', async ({ page }) => {
    await setupMocks(page);
    await page.goto(`/projects/${PROJECT_ID}/triggers`);
    await page.getByRole('button', { name: /open navigation menu/i }).click();
    const badge = page.getByRole('button', { name: /credential attribution health/i });
    await expect(badge).toBeVisible();
    await badge.click();
    await expect(page.getByRole('dialog', { name: /credential attribution/i })).toBeVisible();
    await screenshot(page, 'credential-health-modal-mobile');
    await assertNoOverflow(page);
  });

  test('inline warning and sharing checklist wrap on mobile', async ({ page }) => {
    await setupMocks(page);
    await page.goto(`/projects/${PROJECT_ID}/triggers/${longTrigger.id}`);
    await expect(page.getByText('Personal credential attribution')).toBeVisible();
    await screenshot(page, 'credential-health-trigger-warning-mobile');
    await assertNoOverflow(page);

    await page.goto(`/projects/${PROJECT_ID}/settings`);
    await expect(page.getByText('Credential checklist before sharing')).toBeVisible();
    await screenshot(page, 'credential-health-member-warning-mobile');
    await assertNoOverflow(page);
  });

  test('solo project keeps credential clutter hidden on mobile', async ({ page }) => {
    await setupMocks(page, { multiplayerActive: false });
    await page.goto(`/projects/${PROJECT_ID}/triggers/${longTrigger.id}`);
    await page.getByRole('button', { name: /open navigation menu/i }).click();
    await expect(page.getByRole('button', { name: /credential attribution health/i })).toHaveCount(0);
    await expect(page.getByText('Personal credential attribution')).toHaveCount(0);
    await expect(page.getByText("This runs on Coworker's personal key.")).toHaveCount(0);
    await screenshot(page, 'credential-health-solo-hidden-mobile');
    await assertNoOverflow(page);
  });

  test('health fetch errors leave the compact nav absent without breaking navigation', async ({ page }) => {
    await setupMocks(page, { health: emptyHealth, healthError: true });
    await page.goto(`/projects/${PROJECT_ID}/triggers`);
    await page.getByRole('button', { name: /open navigation menu/i }).click();
    await expect(page.getByRole('dialog', { name: /navigation menu/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /credential attribution health/i })).toHaveCount(0);
    await screenshot(page, 'credential-health-error-hidden-mobile');
    await assertNoOverflow(page);
  });
});
