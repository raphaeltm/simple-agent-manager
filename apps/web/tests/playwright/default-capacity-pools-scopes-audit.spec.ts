import { expect, type Page, test } from '@playwright/test';

import {
  applyMockCapacityDefaultsUpdate,
  assertNoOverflow,
  getProjectSuffix,
  jsonResponse,
  makeMockUser,
  screenshot,
  screenshotNearHeading,
  setupAuditRoutes,
} from './audit-helpers';

const TIMESTAMP = '2026-08-28T00:00:00.000Z';
const EXPENSIVE_HETZNER_GPU_SKU =
  'bare-metal-gpu-ultra-long-provider-native-instance-name-2026-08-stress-row';
const LONG_MARKER =
  'unicode Ω emoji 🚀 and xss text <script>alert("pool")</script> repeated to force wrapping '.repeat(
    3
  );

const user = makeMockUser({
  email: 'pool-user@example.com',
  name: 'Pool Scope User With A Deliberately Long Display Name',
  sessionId: 'session-pool-user',
  userId: 'pool-user',
});

const superadmin = makeMockUser({
  email: 'pool-admin@example.com',
  name: 'Pool Scope Superadmin With A Deliberately Long Display Name',
  role: 'superadmin',
  sessionId: 'session-pool-admin',
  userId: 'pool-admin',
});

const providerNames = ['hetzner', 'scaleway', 'gcp', 'vultr', 'digitalocean', 'upcloud'] as const;
type PoolScope = 'project' | 'user' | 'installation';
const MOCK_PROJECT = {
  id: 'proj-pool-1',
  name: `Compute pool project with long settings label — ${LONG_MARKER}`,
  repository: 'acme/provider-native-compute-pool-project',
  defaultBranch: 'main',
  defaultVmSize: null,
  defaultProvider: 'hetzner',
  defaultLocation: 'fsn1',
  workspaceIdleTimeoutMs: null,
  status: 'active',
  createdAt: TIMESTAMP,
  updatedAt: TIMESTAMP,
};
const nativeOfferings = [
  { sku: 'cx23', vcpu: 2, memoryMb: 4096, diskGb: 40, priceCents: 399 },
  { sku: 'cx33', vcpu: 4, memoryMb: 8192, diskGb: 80, priceCents: 749 },
  {
    sku: 'cx43',
    vcpu: 8,
    memoryMb: 16_384,
    diskGb: 160,
    priceCents: 1449,
  },
  { sku: 'cpx31', vcpu: 4, memoryMb: 8192, diskGb: 160, priceCents: 1310 },
  { sku: 'ccx33', vcpu: 8, memoryMb: 32_768, diskGb: 240, priceCents: 22000 },
  {
    sku: 'bare-metal-gpu-ultra-long-provider-native-instance-name-2026-08-stress-row',
    vcpu: 48,
    memoryMb: 196_608,
    diskGb: 960,
    priceCents: 103_600,
  },
] as const;
const legacySelectedHetznerSkus = {
  cx23: 'small',
  cx33: 'medium',
  cx43: 'large',
} as const;

function nativeOffering(index: number) {
  if (index === 35) return nativeOfferings[2]!;
  return nativeOfferings[index % nativeOfferings.length]!;
}

function priceDisplay(offering: (typeof nativeOfferings)[number]) {
  return offering.priceCents === null ? null : `€${(offering.priceCents / 100).toFixed(2)}/mo`;
}

function priceMonthly(offering: (typeof nativeOfferings)[number]) {
  return offering.priceCents === null ? null : offering.priceCents / 100;
}

function priceHourlyMicros(offering: (typeof nativeOfferings)[number]) {
  return offering.priceCents === null ? null : Math.round((offering.priceCents * 10_000) / 730);
}

function isUnavailableOnlyOffering(offering: (typeof nativeOfferings)[number]) {
  return offering.sku === 'cpx31';
}

function isStaleOffering(offering: (typeof nativeOfferings)[number]) {
  return offering.sku === 'ccx33';
}

function capacityCandidate(scope: PoolScope, index: number) {
  const visibleLocations = ['fsn1', 'nbg1', 'hel1', 'ash', 'hil'];
  const offering = nativeOffering(index);
  const provider =
    index < visibleLocations.length || index === 5 || index === 35
      ? 'hetzner'
      : providerNames[index % providerNames.length];
  const machineSize =
    provider === 'hetzner'
      ? (legacySelectedHetznerSkus[offering.sku as keyof typeof legacySelectedHetznerSkus] ?? null)
      : null;
  return {
    id: `${scope}-candidate-${index}`,
    poolId: `${scope}-default-pool`,
    capacitySourceId: `${scope}-source-${provider}`,
    provider,
    location:
      index === 35
        ? `region-with-a-deliberately-long-location-name-${scope}-${LONG_MARKER}`
        : index === 5
          ? 'fsn1'
          : (visibleLocations[index] ?? `${scope}-region-${index}`),
    workloadRole: 'workspace',
    runtime: index % 5 === 0 ? 'cf-container' : 'vm',
    machineClass: index % 4 === 0 ? 'dedicated-vm' : 'shared-vm',
    machineSize,
    providerInstanceType: offering.sku,
    providerInstanceSku: null,
    providerInstanceDisplayName: `${offering.sku} · ${offering.vcpu} vCPU · ${offering.memoryMb / 1024} GB RAM · ${offering.diskGb} GB disk`,
    providerInstanceVcpuCount: offering.vcpu,
    providerInstanceMemoryMb: offering.memoryMb,
    providerInstanceDiskGb: offering.diskGb,
    providerInstancePriceDisplay: priceDisplay(offering),
    providerInstancePriceCurrency: offering.priceCents === null ? null : 'EUR',
    providerInstancePriceMonthlyCents: offering.priceCents,
    providerInstancePriceHourlyMicros: priceHourlyMicros(offering),
    providerInstanceCatalogSource: 'static',
    providerInstanceCatalogLastSeenAt: isStaleOffering(offering)
      ? '2026-07-01T00:00:00.000Z'
      : null,
    available: isUnavailableOnlyOffering(offering) || isStaleOffering(offering) ? false : true,
    stale: isStaleOffering(offering),
    catalogStatus: isUnavailableOnlyOffering(offering)
      ? 'temporarily unavailable'
      : isStaleOffering(offering)
        ? 'stale catalog data'
        : null,
    priority: index,
    candidateOrder: index,
    status: machineSize ? 'active' : 'disabled',
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
  };
}

function capacitySummary(scope: PoolScope) {
  const candidates = Array.from({ length: 36 }, (_, index) => capacityCandidate(scope, index));
  return {
    pool: {
      id: `${scope}-default-pool`,
      scope,
      ownerUserId: scope === 'user' ? 'pool-user' : null,
      ownerProjectId: scope === 'project' ? MOCK_PROJECT.id : null,
      name:
        scope === 'project'
          ? `Project default compute pool with very long shared-project name — ${LONG_MARKER}`
          : scope === 'user'
            ? `Personal default compute pool with very long owner-managed name — ${LONG_MARKER}`
            : `SAM installation fallback compute pool with very long admin-managed name — ${LONG_MARKER}`,
      isDefault: true,
      revision: 7,
      status: 'active',
      strategy: scope === 'user' ? 'smallest-fit' : 'pack',
      deploymentStrategy: 'smallest-fit',
      exhaustionPolicy: 'queue',
      maxNodes: 3,
      createdAt: TIMESTAMP,
      updatedAt: TIMESTAMP,
    },
    sources: providerNames.map((provider) => ({
      id: `${scope}-source-${provider}`,
      scope,
      ownerUserId: scope === 'user' ? 'pool-user' : null,
      ownerProjectId: scope === 'project' ? MOCK_PROJECT.id : null,
      sourceKind: 'cloud-provider-credential',
      provider,
      credentialSource:
        scope === 'installation' ? 'platform' : scope === 'project' ? 'project' : 'user',
      credentialId: scope === 'installation' ? null : `credential-${scope}-cloud-${provider}`,
      platformCredentialId: scope === 'installation' ? `platform-credential-${provider}` : null,
      credentialReference:
        scope === 'installation'
          ? `platform_credentials:platform-cloud-reference-${provider}-${LONG_MARKER}`
          : scope === 'project'
            ? `credentials:project-cloud-reference-${provider}-${LONG_MARKER}`
            : `credentials:user-cloud-reference-${provider}-${LONG_MARKER}`,
      credentialVersion: 1787875200000,
      externalSourceRef: null,
      status: 'active',
      createdAt: TIMESTAMP,
      updatedAt: TIMESTAMP,
    })),
    candidates,
    activeCandidateCount: candidates.filter((candidate) => candidate.status === 'active').length,
  };
}

function providerCatalogs(scope: PoolScope) {
  const catalogOnlyOfferings = [
    {
      provider: 'hetzner',
      location: 'fsn1',
      providerInstanceType: 'cpx62-catalog-only-live-api-extra',
      providerInstanceSku: null,
      displayName: 'cpx62 catalog-only live API extra',
      sku: 'cpx62-catalog-only-live-api-extra',
      vcpu: 32,
      memoryMb: 65_536,
      diskGb: 480,
      price: '€48.12/mo',
      priceMonthly: 48.12,
      currency: 'EUR',
      available: true,
      stale: false,
      status: null,
      catalogSource: 'api',
      catalogLastSeenAt: TIMESTAMP,
    },
    {
      provider: 'hetzner',
      location: 'nbg1',
      providerInstanceType: 'ccx43-catalog-only-live-api-extra',
      providerInstanceSku: null,
      displayName: 'ccx43 catalog-only live API extra',
      sku: 'ccx43-catalog-only-live-api-extra',
      vcpu: 16,
      memoryMb: 65_536,
      diskGb: 360,
      price: '€138.49/mo',
      priceMonthly: 138.49,
      currency: 'EUR',
      available: true,
      stale: false,
      status: null,
      catalogSource: 'api',
      catalogLastSeenAt: TIMESTAMP,
    },
    {
      provider: 'hetzner',
      location: 'fsn1',
      providerInstanceType: EXPENSIVE_HETZNER_GPU_SKU,
      providerInstanceSku: null,
      displayName: 'bare-metal gpu ultra long provider native instance name 2026-08 stress row',
      sku: EXPENSIVE_HETZNER_GPU_SKU,
      vcpu: 48,
      memoryMb: 196_608,
      diskGb: 960,
      price: '€1036.00/mo',
      priceMonthly: 1036,
      currency: 'EUR',
      available: true,
      stale: false,
      status: null,
      catalogSource: 'api',
      catalogLastSeenAt: TIMESTAMP,
    },
  ];
  return [
    {
      provider: 'hetzner',
      credentialSource: scope === 'installation' ? 'platform' : scope,
      credentialId: scope === 'installation' ? null : `credential-${scope}-cloud-hetzner`,
      platformCredentialId: scope === 'installation' ? 'platform-credential-hetzner' : null,
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
      offerings: [
        ...['fsn1', 'nbg1', 'hel1', 'ash', 'hil'].map((location, index) => {
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
            price: priceDisplay(offering),
            priceMonthly: priceMonthly(offering),
            currency: offering.priceCents === null ? null : 'EUR',
            available:
              isUnavailableOnlyOffering(offering) || isStaleOffering(offering) ? false : true,
            stale: isStaleOffering(offering),
            status: isUnavailableOnlyOffering(offering)
              ? 'temporarily unavailable'
              : isStaleOffering(offering)
                ? 'stale catalog data'
                : null,
            catalogSource: 'static',
            catalogLastSeenAt: isStaleOffering(offering) ? '2026-07-01T00:00:00.000Z' : null,
          };
        }),
        ...catalogOnlyOfferings,
      ],
      defaultLocation: 'fsn1',
    },
  ];
}

function defaultsResponse(scope: PoolScope) {
  const summary = capacitySummary(scope);
  const userSummary =
    scope === 'project' ? capacitySummary('user') : scope === 'user' ? summary : null;
  return {
    effective: summary,
    effectiveScope: scope,
    defaults: [
      {
        scope: 'project',
        visibility: scope === 'project' ? 'visible' : 'hidden',
        visibilityReason: scope === 'project' ? 'project-secret-read' : 'project-context-required',
        canReconcile: scope === 'project',
        summary: scope === 'project' ? summary : null,
      },
      {
        scope: 'user',
        visibility: scope === 'installation' ? 'hidden' : 'visible',
        visibilityReason: scope === 'installation' ? 'user-context-required' : 'authenticated-user',
        canReconcile: scope !== 'installation',
        summary: userSummary,
      },
      {
        scope: 'installation',
        visibility: scope === 'installation' ? 'visible' : 'hidden',
        visibilityReason: scope === 'installation' ? 'superadmin' : 'superadmin-required',
        canReconcile: scope === 'installation',
        summary: scope === 'installation' ? summary : null,
      },
    ],
    precedence: ['project', 'user', 'installation'],
    reconciledScopes: scope === 'project' ? ['project', 'user'] : [scope],
    policyMutationSupported: true,
  };
}

async function setupCommonMocks(page: Page, authUser: unknown, catalogScope: PoolScope) {
  await page.addInitScript(() =>
    ['pool-user', 'pool-admin'].forEach((userId) =>
      localStorage.setItem(`sam-onboarding-wizard-dismissed-${userId}`, 'true')
    )
  );

  await setupAuditRoutes(page, (path, respond) => {
    if (path.startsWith('/api/auth/')) return respond(200, authUser);
    if (path.startsWith('/api/notifications')) {
      return respond(200, { notifications: [], unreadCount: 0 });
    }
    if (path === '/api/projects') {
      return respond(200, {
        projects: catalogScope === 'project' ? [MOCK_PROJECT] : [],
        nextCursor: null,
      });
    }
    if (path === '/api/agents') return respond(200, { agents: [] });
    if (path === '/api/credentials/agent') return respond(200, { credentials: [] });
    if (path === '/api/credentials') return respond(200, []);
    if (path.startsWith('/api/github')) return respond(200, []);
    if (path === '/api/dashboard/active-tasks') return respond(200, { tasks: [] });
    if (path === '/api/providers/catalog') {
      return respond(200, { catalogs: providerCatalogs(catalogScope) });
    }
    return undefined;
  });
}

async function setupUserPoolMocks(page: Page) {
  await setupCommonMocks(page, user, 'user');
  let responseBody = defaultsResponse('user');
  await page.route('**/api/capacity-pools/defaults*', async (route) => {
    if (route.request().method() === 'PATCH') {
      responseBody = applyMockCapacityDefaultsUpdate(responseBody, route.request().postDataJSON());
    }
    return jsonResponse(route, 200, responseBody);
  });
  await page.route('**/api/credentials', (route) => {
    if (route.request().method() !== 'GET') {
      return jsonResponse(route, 200, { id: 'credential-user-cloud-long-id' });
    }
    return jsonResponse(route, 200, [
      {
        id: 'credential-user-cloud-long-id',
        provider: 'hetzner',
        name: `Hetzner personal token with a long visible label ${LONG_MARKER}`,
        createdAt: TIMESTAMP,
        updatedAt: TIMESTAMP,
      },
    ]);
  });
  await page.route('**/api/credentials/validate', (route) =>
    jsonResponse(route, 200, {
      valid: true,
      provider: 'hetzner',
      message: 'credential validated',
    })
  );
}

async function setupInstallationPoolMocks(page: Page) {
  await setupCommonMocks(page, superadmin, 'installation');
  let responseBody = defaultsResponse('installation');
  await page.route('**/api/admin/capacity-pools/defaults*', async (route) => {
    if (route.request().method() === 'PATCH') {
      responseBody = applyMockCapacityDefaultsUpdate(responseBody, route.request().postDataJSON());
    }
    return jsonResponse(route, 200, responseBody);
  });
  await page.route('**/api/admin/platform-credentials', (route) =>
    jsonResponse(route, 200, {
      credentials: [
        {
          id: 'platform-credential-long-id',
          credentialType: 'cloud-provider',
          provider: 'hetzner',
          agentType: null,
          credentialKind: 'api-token',
          label: `Primary Hetzner fallback platform credential ${LONG_MARKER}`,
          isEnabled: true,
          createdAt: TIMESTAMP,
          updatedAt: TIMESTAMP,
        },
      ],
    })
  );
}

async function setupProjectPoolMocks(page: Page) {
  await setupCommonMocks(page, user, 'project');
  let responseBody = defaultsResponse('project');
  await page.route(`**/api/projects/${MOCK_PROJECT.id}/capacity-pools/defaults*`, async (route) => {
    if (route.request().method() === 'PATCH') {
      responseBody = applyMockCapacityDefaultsUpdate(responseBody, route.request().postDataJSON());
    }
    return jsonResponse(route, 200, responseBody);
  });
  await page.route(`**/api/projects/${MOCK_PROJECT.id}/members`, (route) =>
    jsonResponse(route, 200, { members: [] })
  );
  await page.route(`**/api/projects/${MOCK_PROJECT.id}/runtime-config`, (route) =>
    jsonResponse(route, 200, { envVars: [], files: [] })
  );
  await page.route(`**/api/projects/${MOCK_PROJECT.id}`, (route) =>
    jsonResponse(route, 200, MOCK_PROJECT)
  );
}

const POOL_HEADINGS: Record<PoolScope, string> = {
  project: 'Project compute pool',
  user: 'Your compute pool',
  installation: 'Shared compute pool',
};

/** One row per machine type per connection that is allowed in at least one region. */
function allowedRowCount(scope: PoolScope) {
  return new Set(
    capacitySummary(scope)
      .candidates.filter((candidate) => candidate.status === 'active')
      .map((candidate) => `${candidate.capacitySourceId}|${candidate.providerInstanceType}`)
  ).size;
}

async function expectStressedDefaultPool(page: Page, scope: PoolScope) {
  await expect(page.getByRole('heading', { name: POOL_HEADINGS[scope] })).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByText(`Allowed machines (${allowedRowCount(scope)})`)).toBeVisible();
  // The hostile region label (unicode, emoji, markup) renders as wrapped text.
  await expect(
    page.getByText(new RegExp(`region-with-a-deliberately-long-location-name-${scope}`)).first()
  ).toBeVisible();
  // Internal references never render.
  await expect(page.getByText(/credentials:|platform_credentials:/)).toHaveCount(0);
  await expect(page.getByText(/Hidden outside this settings context/i)).toHaveCount(0);
  await assertNoOverflow(page);
}

async function screenshotDefaultPoolScope(
  page: Page,
  heading: string,
  namePrefix: string,
  suffix: string
) {
  await screenshot(page, `${namePrefix}-${suffix}`);
  await screenshotNearHeading(page, heading, `${namePrefix}-focused-${suffix}`);
  await screenshotNearHeading(page, 'Allowed machines', `${namePrefix}-details-${suffix}`);
}

async function editStressedPool(page: Page, screenshotName: string) {
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Allowed machines', exact: true })).toBeVisible();
  await page.getByLabel('Placing agents').selectOption('spread');
  await page.getByLabel(/^Machine limit/).fill('5');
  // The machine limit's longer help makes its grid row taller; the dropdown beside it
  // must keep the same height as the other dropdowns instead of stretching.
  const selectHeights = await Promise.all(
    ['Placing agents', 'If the provider is out of capacity', 'App deployments'].map(
      async (label) => (await page.getByLabel(label, { exact: true }).boundingBox())?.height ?? 0
    )
  );
  expect(Math.min(...selectHeights)).toBeGreaterThan(0);
  expect(Math.max(...selectHeights) - Math.min(...selectHeights)).toBeLessThanOrEqual(1);
  await page.getByRole('button', { name: 'cx33 in Nuremberg', exact: true }).click();
  await page.getByRole('button', { name: 'cx43 in Helsinki', exact: true }).click();
  await screenshotNearHeading(page, 'Allowed machines', screenshotName);

  for (const showMore of await page
    .getByRole('button', { name: /^Show \d+ more machine types?$/ })
    .all()) {
    await showMore.click();
  }
  await expect(
    page.getByRole('button', { name: 'cpx31 in Ashburn (temporarily unavailable)', exact: true })
  ).toBeDisabled();
  await expect(
    page.getByRole('button', { name: 'ccx33 in Hillsboro (not currently offered)', exact: true })
  ).toBeDisabled();
  await page
    .getByRole('button', { name: 'cpx62-catalog-only-live-api-extra in Falkenstein', exact: true })
    .click();
  await assertNoOverflow(page);

  await page.getByRole('searchbox', { name: 'Search machine types' }).fill('bare-metal');
  await expect(page.getByText(EXPENSIVE_HETZNER_GPU_SKU).first()).toBeVisible();
  await screenshotNearHeading(page, 'Allowed machines', `${screenshotName}-search`);

  await page.getByRole('button', { name: 'Save changes' }).click();
  // cx33's only region was turned off; the catalog-only cpx62 joins.
  await expect(page.getByText('cpx62-catalog-only-live-api-extra', { exact: true })).toBeVisible();
  await expect(page.getByText('cx33', { exact: true })).toHaveCount(0);
  await assertNoOverflow(page);
}

test.describe('Default capacity pool scope surfaces', () => {
  // Each scope exercises filters, membership edits, persistence, and multiple
  // screenshots; the shared single-screen timeout is too short for this flow.
  test.setTimeout(120_000);

  test('project settings surface renders stressed project default pool without overflow', async ({
    page,
  }, testInfo) => {
    await setupProjectPoolMocks(page);
    await page.goto(`/projects/${MOCK_PROJECT.id}/settings/infrastructure`);

    const suffix = getProjectSuffix(testInfo.project.name);
    await expectStressedDefaultPool(page, 'project');
    await screenshotDefaultPoolScope(
      page,
      POOL_HEADINGS.project,
      'default-capacity-pools-project',
      suffix
    );
    await editStressedPool(page, `default-capacity-pools-project-edit-${suffix}`);
  });

  test('user settings surface renders stressed user default pool without overflow', async ({
    page,
  }, testInfo) => {
    await setupUserPoolMocks(page);
    await page.goto('/settings/infrastructure');

    const suffix = getProjectSuffix(testInfo.project.name);
    await expectStressedDefaultPool(page, 'user');
    await screenshotDefaultPoolScope(
      page,
      POOL_HEADINGS.user,
      'default-capacity-pools-user',
      suffix
    );
    await editStressedPool(page, `default-capacity-pools-user-edit-${suffix}`);
  });

  test('admin surface renders stressed installation default pool without overflow', async ({
    page,
  }, testInfo) => {
    await setupInstallationPoolMocks(page);
    await page.goto('/admin/infrastructure');

    const suffix = getProjectSuffix(testInfo.project.name);
    await expectStressedDefaultPool(page, 'installation');
    await screenshotDefaultPoolScope(
      page,
      POOL_HEADINGS.installation,
      'default-capacity-pools-installation',
      suffix
    );
    await editStressedPool(page, `default-capacity-pools-installation-edit-${suffix}`);
  });
});
