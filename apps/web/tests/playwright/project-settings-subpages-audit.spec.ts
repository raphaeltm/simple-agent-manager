import { expect, type Page, test } from '@playwright/test';

import {
  applyMockCapacityDefaultsUpdate,
  assertNoClippedOverflow,
  assertNoOverflow,
  makeMockUser,
  screenshot,
  screenshotNearHeading,
  screenshotSectionNearHeading,
  setupAuditRoutes,
} from './audit-helpers';

const PROJECT_ID = 'proj-settings-1';
const POOL_LONG_MARKER =
  'unicode Ω emoji 🚀 and xss text <script>alert("project-pool")</script> repeated for wrapping '.repeat(
    3
  );
const REMOVE_TARGETS = [
  { location: 'ash', sku: 'hcx-project-ash-4vcpu-8gb' },
  { location: 'hil', sku: 'hcx-project-hil-8vcpu-16gb' },
] as const;

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

function providerForIndex(index: number) {
  const providers = ['hetzner', 'scaleway', 'gcp', 'vultr', 'digitalocean', 'upcloud'];
  return index < 6 ? 'hetzner' : providers[index % providers.length];
}

function skuForIndex(index: number) {
  if (index === 3) return REMOVE_TARGETS[0].sku;
  if (index === 4) return REMOVE_TARGETS[1].sku;
  if (index === 35) return `project-provider-native-sku-with-a-long-name-${POOL_LONG_MARKER}`;
  const shape = index % 5 === 0 ? 'dedicated' : 'shared';
  return `${providerForIndex(index)}-${shape}-${index + 1}vcpu-${(index % 8) + 4}gb`;
}

function priceForIndex(index: number) {
  if (index === 7) return null;
  if (index === 14) return '€899.99/mo';
  if (index % 6 === 0) return '~€0.031/hr';
  return `€${(4.1 + index * 2.35).toFixed(2)}/mo`;
}

function capacityCandidate(index: number, overrides: Record<string, unknown> = {}) {
  const visibleLocations = ['fsn1', 'nbg1', 'hel1', 'ash', 'hil'];
  const price = priceForIndex(index);
  return {
    id: `candidate-${index}`,
    poolId: 'pool-project-default',
    capacitySourceId: 'source-project-default',
    provider: providerForIndex(index),
    location: visibleLocations[index] ?? `region-${index}`,
    workloadRole: 'workspace',
    runtime: 'vm',
    machineClass: 'shared-vm',
    machineSize: index % 3 === 0 ? 'small' : index % 3 === 1 ? 'medium' : 'large',
    providerInstanceType: skuForIndex(index),
    providerInstanceVcpuCount: index === 3 ? 4 : index === 4 ? 8 : (index % 12) + 1,
    providerInstanceMemoryMb: index === 3 ? 8192 : index === 4 ? 16_384 : ((index % 16) + 4) * 1024,
    providerInstanceDiskGb: index % 7 === 0 ? 0 : (index + 1) * 20,
    providerInstancePriceDisplay: price,
    providerInstancePriceCurrency: price ? 'EUR' : null,
    providerInstancePriceMonthlyCents:
      price && price.includes('/mo') ? Math.round(Number(price.replace(/[^0-9.]/g, '')) * 100) : null,
    providerInstancePriceHourlyMicros:
      price && price.includes('/hr')
        ? Math.round(Number(price.replace(/[^0-9.]/g, '')) * 1_000_000)
        : null,
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
    capacityCandidate(0, { machineSize: 'small' }),
    capacityCandidate(1, { machineSize: 'medium' }),
    capacityCandidate(2, { machineSize: 'large' }),
    capacityCandidate(3, { machineSize: 'small' }),
    capacityCandidate(4, { machineSize: 'medium' }),
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

function providerCatalogResponse() {
  const candidates = Array.from({ length: 36 }, (_, index) =>
    index === 35
      ? capacityCandidate(index, {
          location: 'region-with-a-very-long-location-name-and-special-marker-ß',
        })
      : capacityCandidate(index)
  );
  const byProvider = new Map<string, ReturnType<typeof capacityCandidate>[]>();
  for (const candidate of candidates) {
    const items = byProvider.get(candidate.provider) ?? [];
    items.push(candidate);
    byProvider.set(candidate.provider, items);
  }

  return {
    catalogs: [...byProvider.entries()].map(([provider, providerCandidates]) => ({
      provider,
      defaultLocation: providerCandidates[0]?.location ?? 'default-region',
      locations: [...new Set(providerCandidates.map((candidate) => candidate.location))]
        .filter((location): location is string => Boolean(location))
        .map((location) => ({
          id: location,
          name: location.startsWith('region-with-a-very-long')
            ? location
            : `${location.toUpperCase()} project region`,
          country: location === 'ash' || location === 'hil' ? 'US' : 'EU',
        })),
      sizes: {
        small: {
          type: `${provider}-legacy-compat-a`,
          price: '€3.99/mo',
          vcpu: 2,
          ramGb: 4,
          storageGb: 40,
        },
        medium: {
          type: `${provider}-legacy-compat-b`,
          price: '€12.99/mo',
          vcpu: 4,
          ramGb: 8,
          storageGb: 120,
        },
        large: {
          type: `${provider}-legacy-compat-c`,
          price: '€49.99/mo',
          vcpu: 8,
          ramGb: 32,
          storageGb: 240,
        },
      },
      offerings: [
        ...providerCandidates.map((candidate, index) => ({
          sku: candidate.providerInstanceType,
          location: candidate.location,
          locationName: candidate.location?.startsWith('region-with-a-very-long')
            ? candidate.location
            : `${candidate.location?.toUpperCase()} project region`,
          country: candidate.location === 'ash' || candidate.location === 'hil' ? 'US' : 'EU',
          vcpu: candidate.providerInstanceVcpuCount,
          memoryMb: candidate.providerInstanceMemoryMb,
          diskGb: candidate.providerInstanceDiskGb,
          price: candidate.providerInstancePriceDisplay,
          available: index === 13 ? false : true,
          stale: index === 21,
          status:
            index === 13 ? 'provider capacity unavailable' : index === 21 ? 'stale catalog row' : null,
        })),
        {
          sku: `project-catalog-only-gpu-offering-${POOL_LONG_MARKER}`,
          location: 'catalog-only-project-region',
          locationName: `Catalog Only Project Region ${POOL_LONG_MARKER}`,
          country: 'CA',
          vcpu: 64,
          memoryGb: 512,
          diskGb: 4096,
          price: '€1999.99/mo',
          available: false,
          status: 'not yet seedable from this UI',
        },
      ],
    })),
  };
}

async function setupMocks(page: Page) {
  await page.addInitScript(() =>
    localStorage.setItem('sam-onboarding-wizard-dismissed-owner-user', 'true')
  );

  await setupAuditRoutes(page, (path, respond, route) => {
    if (path.startsWith('/api/auth/')) return respond(200, MOCK_USER);
    if (path === '/api/projects') return respond(200, { projects: [project] });
    if (path === '/api/agents') return respond(200, { agents: [] });
    if (path === '/api/dashboard/active-tasks') return respond(200, { tasks: [] });
    if (path === '/api/providers/catalog') return respond(200, providerCatalogResponse());
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
    await expect(page.getByText('hetzner-dedicated-1vcpu-4gb')).toBeVisible();
    await expect(page.getByText(/Hetzner · FSN1 project region/)).toBeVisible();
    await expect(page.getByText(/Hidden outside this settings context/i)).toHaveCount(0);
    await expect(page.getByText(/Installation defaults require/i)).toHaveCount(0);
    await expectCompactTabs(page);
    await screenshotNearHeading(
      page,
      'Project Infrastructure Compute Pool',
      'project-settings-default-compute-pool-normal-focused',
    );
    await screenshotSectionNearHeading(
      page,
      'Project Infrastructure Compute Pool',
      'project-settings-default-compute-pool-normal-section'
    );

    await page.getByRole('button', { name: 'Edit' }).click();
    await expect(page.getByRole('heading', { name: 'Edit project default' })).toBeVisible();
    await page
      .getByRole('button', { name: `Remove Hetzner ${REMOVE_TARGETS[0].location} ${REMOVE_TARGETS[0].sku}` })
      .click();
    await page
      .getByRole('button', { name: `Remove Hetzner ${REMOVE_TARGETS[1].location} ${REMOVE_TARGETS[1].sku}` })
      .click();
    await expect(page.getByText(/3 allowed · 2 removed\/disabled/)).toBeVisible();
    await screenshotNearHeading(
      page,
      'Edit project default',
      'project-settings-default-compute-pool-edit-focused',
    );
    await screenshotNearHeading(
      page,
      'Removed or disabled instances',
      'project-settings-default-compute-pool-edit-removed-focused'
    );
    await screenshotNearHeading(
      page,
      'Catalog filters',
      'project-settings-default-compute-pool-edit-catalog-focused'
    );
    await screenshotNearHeading(
      page,
      'Add instances from catalog',
      'project-settings-default-compute-pool-edit-catalog-results-focused'
    );
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByText(/3 allowed · 2 removed\/disabled/)).toBeVisible();
    await expect(page.getByText('Removed or disabled instances')).toBeVisible();
    await assertNoOverflow(page);
    await assertNoClippedOverflow(page);

    capacityDefaultsBody = capacityDefaults(userCapacitySummary());
    await page.goto(`/projects/${PROJECT_ID}/settings/infrastructure?case=fallback`);
    await expect(page.getByText('Using user fallback.', { exact: false })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Edit' })).toHaveCount(0);
    await expect(page.getByText(/Hidden outside this settings context/i)).toHaveCount(0);
    await screenshotNearHeading(
      page,
      'Project Infrastructure Compute Pool',
      'project-settings-default-compute-pool-user-fallback-focused',
    );
    await screenshotSectionNearHeading(
      page,
      'Project Infrastructure Compute Pool',
      'project-settings-default-compute-pool-user-fallback-section'
    );
    await assertNoOverflow(page);
    await assertNoClippedOverflow(page);

    capacityDefaultsBody = capacityDefaults(null);
    await page.goto(`/projects/${PROJECT_ID}/settings/infrastructure?case=empty`);
    await expect(page.getByText('No visible active default pool')).toBeVisible();
    await expect(page.getByText('Project compute credentials are required')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Set up project credentials' })).toBeVisible();
    await screenshotNearHeading(
      page,
      'Project Infrastructure Compute Pool',
      'project-settings-default-compute-pool-empty-focused',
    );
    await screenshotSectionNearHeading(
      page,
      'Project Infrastructure Compute Pool',
      'project-settings-default-compute-pool-empty-section'
    );
    await assertNoOverflow(page);
    await assertNoClippedOverflow(page);

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
      page.getByText('project-provider-native-sku-with-a-long-name-', { exact: false })
    ).toBeVisible();
    await expect(page.getByText(/\+\d+ more provider\/region groups/)).toHaveCount(0);
    await expect(page.getByText('Price unavailable')).toBeVisible();
    await expect(page.getByText('€899.99/mo')).toBeVisible();
    await screenshotNearHeading(
      page,
      'Project Infrastructure Compute Pool',
      'project-settings-default-compute-pool-many-focused',
    );
    await screenshotSectionNearHeading(
      page,
      'Project Infrastructure Compute Pool',
      'project-settings-default-compute-pool-many-section'
    );
    await assertNoOverflow(page);
    await assertNoClippedOverflow(page);

    capacityDefaultsStatus = 403;
    capacityDefaultsBody = {
      error: 'FORBIDDEN',
      message: 'Project capability is required',
    };
    await page.goto(`/projects/${PROJECT_ID}/settings/infrastructure?case=error`);
    await expect(page.getByText('Project capability is required')).toBeVisible();
    await screenshotNearHeading(
      page,
      'Project Infrastructure Compute Pool',
      'project-settings-default-compute-pool-error-focused',
    );
    await screenshotSectionNearHeading(
      page,
      'Project Infrastructure Compute Pool',
      'project-settings-default-compute-pool-error-section'
    );
    await assertNoOverflow(page);
    await assertNoClippedOverflow(page);
  });
});
