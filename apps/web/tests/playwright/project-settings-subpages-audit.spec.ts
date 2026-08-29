import { expect, type Page, test } from '@playwright/test';

import {
  applyMockCapacityDefaultsUpdate,
  assertNoOverflow,
  makeMockUser,
  screenshot,
  screenshotNearHeading,
  setupAuditRoutes,
} from './audit-helpers';

const PROJECT_ID = 'proj-settings-1';
const nativeOfferings = [
  { sku: 'cx23', vcpu: 2, memoryMb: 4096, diskGb: 40, priceCents: 399 },
  { sku: 'cx33', vcpu: 4, memoryMb: 8192, diskGb: 80, priceCents: 749 },
  { sku: 'cx43', vcpu: 8, memoryMb: 16_384, diskGb: 160, priceCents: 1449 },
  { sku: 'cpx31', vcpu: 4, memoryMb: 8192, diskGb: 160, priceCents: 1310 },
  { sku: 'ccx33', vcpu: 8, memoryMb: 32_768, diskGb: 240, priceCents: 5520 },
] as const;

function nativeOffering(index: number) {
  return nativeOfferings[index % nativeOfferings.length]!;
}

const MOCK_USER = makeMockUser({
  userId: 'owner-user',
  sessionId: 'session-project-settings',
  email: 'owner@example.com',
  name: 'Owner User',
  role: 'user',
});

const project = {
  id: PROJECT_ID,
  name: 'Project With A Very Long Name For Settings Navigation And Mobile Header Wrapping Validation',
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

function capacityCandidate(index: number, overrides: Record<string, unknown> = {}) {
  const visibleLocations = ['fsn1', 'nbg1', 'hel1', 'ash', 'hil'];
  const offering = nativeOffering(index);
  return {
    id: `candidate-${index}`,
    poolId: 'pool-project-default',
    capacitySourceId: 'source-project-default',
    provider: 'hetzner',
    location: visibleLocations[index] ?? `region-${index}`,
    workloadRole: 'workspace',
    runtime: 'vm',
    machineClass: 'shared-vm',
    machineSize: index % 3 === 0 ? 'small' : index % 3 === 1 ? 'medium' : 'large',
    providerInstanceType: offering.sku,
    providerInstanceSku: null,
    providerInstanceDisplayName: `${offering.sku} · ${offering.vcpu} vCPU · ${offering.memoryMb / 1024} GB RAM · ${offering.diskGb} GB disk`,
    providerInstanceVcpuCount: offering.vcpu,
    providerInstanceMemoryMb: offering.memoryMb,
    providerInstanceDiskGb: offering.diskGb,
    providerInstancePriceDisplay: `€${(offering.priceCents / 100).toFixed(2)}/mo`,
    providerInstancePriceCurrency: 'EUR',
    providerInstancePriceMonthlyCents: offering.priceCents,
    providerInstancePriceHourlyMicros: Math.round((offering.priceCents * 10_000) / 730),
    providerInstanceCatalogSource: 'static',
    providerInstanceCatalogLastSeenAt: null,
    priority: index,
    candidateOrder: index,
    status: 'active',
    createdAt: '2026-08-28T00:00:00.000Z',
    updatedAt: '2026-08-28T00:00:00.000Z',
    ...overrides,
  };
}

function capacitySummary(overrides: Record<string, unknown> = {}) {
  const candidates = [
    capacityCandidate(0),
    capacityCandidate(1),
    capacityCandidate(2),
    capacityCandidate(3),
    capacityCandidate(4),
  ];
  return {
    pool: {
      id: 'pool-project-default',
      scope: 'project',
      ownerUserId: null,
      ownerProjectId: PROJECT_ID,
      name: 'Project default pool with a deliberately long name and unicode marker Ω for wrapping',
      isDefault: true,
      revision: 2,
      status: 'active',
      strategy: 'balanced',
      exhaustionPolicy: 'queue',
      createdAt: '2026-08-28T00:00:00.000Z',
      updatedAt: '2026-08-28T00:00:00.000Z',
    },
    sources: [
      {
        id: 'source-project-default',
        scope: 'project',
        ownerUserId: null,
        ownerProjectId: PROJECT_ID,
        sourceKind: 'cloud-provider-credential',
        provider: 'hetzner',
        credentialSource: 'project',
        credentialId: 'credential-project-default',
        platformCredentialId: null,
        credentialReference:
          'credentials:credential-project-default-with-long-reference-for-wrapping-only',
        credentialVersion: 1787875200000,
        externalSourceRef: null,
        status: 'active',
        createdAt: '2026-08-28T00:00:00.000Z',
        updatedAt: '2026-08-28T00:00:00.000Z',
      },
    ],
    candidates,
    activeCandidateCount: candidates.length,
    ...overrides,
  };
}

function providerCatalog() {
  return {
    provider: 'hetzner',
    credentialSource: 'project',
    credentialId: 'credential-project-default',
    platformCredentialId: null,
    locations: [
      { id: 'fsn1', name: 'Falkenstein', country: 'DE' },
      { id: 'nbg1', name: 'Nuremberg', country: 'DE' },
      { id: 'hel1', name: 'Helsinki', country: 'FI' },
      { id: 'ash', name: 'Ashburn', country: 'US' },
      { id: 'hil', name: 'Hillsboro', country: 'US' },
    ],
    sizes: {
      small: { type: 'cx23', price: '€3.99/mo', vcpu: 2, ramGb: 4, storageGb: 40 },
      medium: { type: 'cx33', price: '€7.49/mo', vcpu: 4, ramGb: 8, storageGb: 80 },
      large: { type: 'cx43', price: '€14.49/mo', vcpu: 8, ramGb: 16, storageGb: 160 },
    },
    offerings: ['fsn1', 'nbg1', 'hel1', 'ash', 'hil'].map((location, index) => {
      const offering = nativeOffering(index);
      return {
        provider: 'hetzner',
        location,
        providerInstanceType: offering.sku,
        providerInstanceSku: null,
        displayName: `${offering.sku} catalog row`,
        sku: offering.sku,
        vcpu: offering.vcpu,
        memoryMb: offering.memoryMb,
        diskGb: offering.diskGb,
        price: `€${(offering.priceCents / 100).toFixed(2)}/mo`,
        priceMonthly: offering.priceCents / 100,
        currency: 'EUR',
        available: true,
        catalogSource: 'static',
        catalogLastSeenAt: null,
      };
    }),
    defaultLocation: 'fsn1',
  };
}

function userCapacitySummary() {
  const projectSummary = capacitySummary();
  return {
    ...projectSummary,
    pool: {
      ...projectSummary.pool,
      id: 'pool-user-default',
      scope: 'user',
      ownerUserId: 'owner-user',
      ownerProjectId: null,
      name: 'Owner user fallback pool visible to project settings without project override',
    },
    sources: projectSummary.sources.map((source) => ({
      ...source,
      id: 'source-user-default',
      scope: 'user',
      ownerUserId: 'owner-user',
      ownerProjectId: null,
      credentialSource: 'user',
      credentialId: 'credential-user-default',
      credentialReference: 'credentials:credential-user-default',
    })),
    candidates: projectSummary.candidates.map((candidate, index) => ({
      ...candidate,
      id: `user-fallback-candidate-${index}`,
      poolId: 'pool-user-default',
      capacitySourceId: 'source-user-default',
    })),
  };
}

type ProjectSettingsCapacitySummary = ReturnType<typeof capacitySummary>;

function capacityDefaults(effective: ProjectSettingsCapacitySummary | null) {
  const effectiveScope =
    effective && typeof effective === 'object' && 'pool' in effective
      ? ((effective as { pool?: { scope?: string } }).pool?.scope ?? null)
      : null;
  return {
    effective,
    effectiveScope,
    defaults: [
      {
        scope: 'project',
        visibility: 'visible',
        visibilityReason: 'project-secret-read',
        canReconcile: true,
        summary: effectiveScope === 'project' ? effective : null,
      },
      {
        scope: 'user',
        visibility: 'visible',
        visibilityReason: 'authenticated-user',
        canReconcile: true,
        summary: effectiveScope === 'user' ? effective : null,
      },
      {
        scope: 'installation',
        visibility: 'hidden',
        visibilityReason: 'superadmin-required',
        canReconcile: false,
        summary: null,
      },
    ],
    precedence: ['project', 'user', 'installation'],
    reconciledScopes: ['project', 'user'],
    policyMutationSupported: true,
  };
}

let capacityDefaultsStatus = 200;
let capacityDefaultsBody: unknown = capacityDefaults(capacitySummary());

async function setupMocks(page: Page) {
  await page.addInitScript(() =>
    localStorage.setItem('sam-onboarding-wizard-dismissed-owner-user', 'true')
  );

  await setupAuditRoutes(page, (path, respond, route) => {
    if (path.startsWith('/api/auth/')) return respond(200, MOCK_USER);
    if (path === '/api/projects') return respond(200, { projects: [project] });
    if (path === '/api/agents') return respond(200, { agents: [] });
    if (path === '/api/dashboard/active-tasks') return respond(200, { tasks: [] });
    if (path === '/api/providers/catalog') return respond(200, { catalogs: [providerCatalog()] });
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
      if (
        subPath === '/capacity-pools/defaults' ||
        subPath === '/capacity-pools/defaults/reconcile'
      ) {
        if (subPath === '/capacity-pools/defaults' && route.request().method() === 'PATCH') {
          capacityDefaultsBody = applyMockCapacityDefaultsUpdate(
            capacityDefaultsBody as ReturnType<typeof capacityDefaults>,
            route.request().postDataJSON()
          );
        }
        return respond(capacityDefaultsStatus, capacityDefaultsBody);
      }
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
    capacityDefaultsStatus = 200;
    capacityDefaultsBody = capacityDefaults(capacitySummary());
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

  test('Infrastructure sub-page exposes default compute pool states without overflow', async ({
    page,
  }) => {
    await page.goto(`/projects/${PROJECT_ID}/settings/infrastructure`);
    await expect(
      page.getByRole('heading', { name: 'Project Infrastructure Compute Pool' })
    ).toBeVisible();
    await expect(page.getByText('Project default applies to this context.')).toBeVisible();
    await expect(page.getByText(/Hetzner · Falkenstein \(fsn1\)/)).toBeVisible();
    await expect(page.getByText(/Hidden outside this settings context/i)).toHaveCount(0);
    await expect(page.getByText(/Installation defaults require/i)).toHaveCount(0);
    await expectCompactTabs(page);
    await screenshot(page, 'project-settings-infrastructure-capacity-pool-normal');
    await screenshotNearHeading(
      page,
      'Project Infrastructure Compute Pool',
      'project-settings-default-compute-pool-normal-focused'
    );

    await page.getByRole('button', { name: 'Edit' }).click();
    await expect(page.getByRole('heading', { name: 'Edit project default' })).toBeVisible();
    await page.getByRole('button', { name: /Remove Hetzner ash cpx31/ }).click();
    await page.getByRole('button', { name: /Remove Hetzner hil ccx33/ }).click();
    await screenshotNearHeading(
      page,
      'Edit project default',
      'project-settings-default-compute-pool-edit-focused'
    );
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByText(/3 allowed · 2 removed\/disabled/)).toBeVisible();
    await expect(
      page.getByRole('heading', { name: 'Removed or disabled instances' })
    ).toBeVisible();
    await expect(page.getByText(/Hetzner · Ashburn \(ash\)/).first()).toBeVisible();
    await expect(page.getByText(/Hetzner · Hillsboro \(hil\)/).first()).toBeVisible();
    await assertNoOverflow(page);

    capacityDefaultsBody = capacityDefaults(userCapacitySummary());
    await page.goto(`/projects/${PROJECT_ID}/settings/infrastructure?case=fallback`);
    await expect(page.getByText('Using user fallback.', { exact: false })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Edit' })).toHaveCount(0);
    await expect(page.getByText(/Hidden outside this settings context/i)).toHaveCount(0);
    await screenshot(page, 'project-settings-infrastructure-capacity-pool-user-fallback');
    await screenshotNearHeading(
      page,
      'Project Infrastructure Compute Pool',
      'project-settings-default-compute-pool-user-fallback-focused'
    );
    await assertNoOverflow(page);

    capacityDefaultsBody = capacityDefaults(null);
    await page.goto(`/projects/${PROJECT_ID}/settings/infrastructure?case=empty`);
    await expect(page.getByText('No visible active default pool')).toBeVisible();
    await screenshot(page, 'project-settings-infrastructure-capacity-pool-empty');
    await screenshotNearHeading(
      page,
      'Project Infrastructure Compute Pool',
      'project-settings-default-compute-pool-empty-focused'
    );
    await assertNoOverflow(page);

    const manyCandidates = Array.from({ length: 36 }, (_, index) =>
      capacityCandidate(index, {
        location:
          index === 35
            ? 'region-with-a-very-long-location-name-and-special-marker-ß'
            : `region-${index}`,
      })
    );
    capacityDefaultsBody = capacityDefaults(
      capacitySummary({
        candidates: manyCandidates,
        activeCandidateCount: manyCandidates.length,
      })
    );
    await page.goto(`/projects/${PROJECT_ID}/settings/infrastructure?case=many`);
    await expect(
      page.getByText('Hetzner · region-with-a-very-long-location-name-and-special-marker-ß')
    ).toBeVisible();
    await expect(page.getByText(/\+\d+ more provider\/region groups/)).toHaveCount(0);
    await screenshot(page, 'project-settings-infrastructure-capacity-pool-many');
    await screenshotNearHeading(
      page,
      'Project Infrastructure Compute Pool',
      'project-settings-default-compute-pool-many-focused'
    );
    await assertNoOverflow(page);

    capacityDefaultsStatus = 403;
    capacityDefaultsBody = {
      error: 'FORBIDDEN',
      message: 'Project capability is required',
    };
    await page.goto(`/projects/${PROJECT_ID}/settings/infrastructure?case=error`);
    await expect(page.getByText('Project capability is required')).toBeVisible();
    await screenshot(page, 'project-settings-infrastructure-capacity-pool-error');
    await screenshotNearHeading(
      page,
      'Project Infrastructure Compute Pool',
      'project-settings-default-compute-pool-error-focused'
    );
    await assertNoOverflow(page);
  });
});
