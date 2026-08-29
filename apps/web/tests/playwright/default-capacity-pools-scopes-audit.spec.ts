import { expect, type Page, test } from '@playwright/test';

import {
  applyMockCapacityDefaultsUpdate,
  assertNoOverflow,
  getProjectSuffix,
  jsonResponse,
  makeMockUser,
  screenshot,
  screenshotNearHeading,
  screenshotSectionNearHeading,
  setupAuditRoutes,
} from './audit-helpers';

const TIMESTAMP = '2026-08-28T00:00:00.000Z';
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
const nativeOfferings = [
  { sku: 'cx23', vcpu: 2, memoryMb: 4096, diskGb: 40, priceCents: 399 },
  { sku: 'cx33', vcpu: 4, memoryMb: 8192, diskGb: 80, priceCents: 749 },
  {
    sku: 'cx43-provider-native-sku-with-deliberately-long-name-for-mobile-wrapping',
    vcpu: 8,
    memoryMb: 16_384,
    diskGb: 160,
    priceCents: 1449,
  },
  { sku: 'cpx31', vcpu: 4, memoryMb: 8192, diskGb: 160, priceCents: null },
  { sku: 'ccx33', vcpu: 8, memoryMb: 32_768, diskGb: 240, priceCents: 22000 },
  {
    sku: 'bare-metal-gpu-ultra-long-provider-native-instance-name-2026-08-stress-row',
    vcpu: 48,
    memoryMb: 196_608,
    diskGb: 960,
    priceCents: 99000,
  },
] as const;

function nativeOffering(index: number) {
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

function capacityCandidate(scope: 'user' | 'installation', index: number) {
  const visibleLocations = ['fsn1', 'nbg1', 'hel1', 'ash', 'hil'];
  const offering = nativeOffering(index);
  const provider =
    index < visibleLocations.length ? 'hetzner' : providerNames[index % providerNames.length];
  return {
    id: `${scope}-candidate-${index}`,
    poolId: `${scope}-default-pool`,
    capacitySourceId: `${scope}-source-${provider}`,
    provider,
    location:
      index === 35
        ? `region-with-a-deliberately-long-location-name-${scope}-${LONG_MARKER}`
        : (visibleLocations[index] ?? `${scope}-region-${index}`),
    workloadRole: 'workspace',
    runtime: index % 5 === 0 ? 'cf-container' : 'vm',
    machineClass: index % 4 === 0 ? 'dedicated-vm' : 'shared-vm',
    machineSize: index % 3 === 0 ? 'small' : index % 3 === 1 ? 'medium' : 'large',
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
    providerInstanceCatalogLastSeenAt: offering.sku === 'ccx33' ? '2026-07-01T00:00:00.000Z' : null,
    available: offering.sku === 'ccx33' ? false : true,
    stale: offering.sku === 'ccx33',
    catalogStatus: offering.sku === 'ccx33' ? 'temporarily unavailable' : null,
    priority: index,
    candidateOrder: index,
    status: 'active',
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
  };
}

function capacitySummary(scope: 'user' | 'installation') {
  const candidates = Array.from({ length: 36 }, (_, index) => capacityCandidate(scope, index));
  return {
    pool: {
      id: `${scope}-default-pool`,
      scope,
      ownerUserId: scope === 'user' ? 'pool-user' : null,
      ownerProjectId: null,
      name:
        scope === 'user'
          ? `Personal default compute pool with very long owner-managed name — ${LONG_MARKER}`
          : `SAM installation fallback compute pool with very long admin-managed name — ${LONG_MARKER}`,
      isDefault: true,
      revision: 7,
      status: 'active',
      strategy: scope === 'user' ? 'smallest-fit' : 'pack',
      exhaustionPolicy: 'queue',
      createdAt: TIMESTAMP,
      updatedAt: TIMESTAMP,
    },
    sources: providerNames.map((provider) => ({
      id: `${scope}-source-${provider}`,
      scope,
      ownerUserId: scope === 'user' ? 'pool-user' : null,
      ownerProjectId: null,
      sourceKind: 'cloud-provider-credential',
      provider,
      credentialSource: scope === 'user' ? 'user' : 'platform',
      credentialId: scope === 'user' ? `credential-user-cloud-${provider}` : null,
      platformCredentialId: scope === 'installation' ? `platform-credential-${provider}` : null,
      credentialReference:
        scope === 'user'
          ? `credentials:user-cloud-reference-${provider}-${LONG_MARKER}`
          : `platform_credentials:platform-cloud-reference-${provider}-${LONG_MARKER}`,
      credentialVersion: 1787875200000,
      externalSourceRef: null,
      status: 'active',
      createdAt: TIMESTAMP,
      updatedAt: TIMESTAMP,
    })),
    candidates,
    activeCandidateCount: candidates.length,
  };
}

function providerCatalogs(scope: 'user' | 'installation') {
  return [
    {
      provider: 'hetzner',
      credentialSource: scope === 'user' ? 'user' : 'platform',
      credentialId: scope === 'user' ? 'credential-user-cloud-hetzner' : null,
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
          price: priceDisplay(offering),
          priceMonthly: priceMonthly(offering),
          currency: offering.priceCents === null ? null : 'EUR',
          available: offering.sku === 'ccx33' ? false : true,
          stale: offering.sku === 'ccx33',
          status: offering.sku === 'ccx33' ? 'temporarily unavailable' : null,
          catalogSource: 'static',
          catalogLastSeenAt: offering.sku === 'ccx33' ? '2026-07-01T00:00:00.000Z' : null,
        };
      }),
      defaultLocation: 'fsn1',
    },
  ];
}

function defaultsResponse(scope: 'user' | 'installation') {
  const summary = capacitySummary(scope);
  return {
    effective: summary,
    effectiveScope: scope,
    defaults: [
      {
        scope: 'project',
        visibility: 'hidden',
        visibilityReason: 'project-context-required',
        canReconcile: false,
        summary: null,
      },
      {
        scope: 'user',
        visibility: scope === 'user' ? 'visible' : 'hidden',
        visibilityReason: scope === 'user' ? 'authenticated-user' : 'user-context-required',
        canReconcile: scope === 'user',
        summary: scope === 'user' ? summary : null,
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
    reconciledScopes: [scope],
    policyMutationSupported: true,
  };
}

async function setupCommonMocks(
  page: Page,
  authUser: unknown,
  catalogScope: 'user' | 'installation'
) {
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
    if (path === '/api/projects') return respond(200, { projects: [], nextCursor: null });
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

async function expectStressedDefaultPool(
  page: Page,
  heading: string,
  scope: 'user' | 'installation'
) {
  await expect(page.getByRole('heading', { name: heading })).toBeVisible();
  await expect(page.getByText(/36 allowed · 0 removed\/disabled/)).toBeVisible();
  await expect(
    page.getByText(new RegExp(`region-with-a-deliberately-long-location-name-${scope}`))
  ).toBeVisible();
  await expect(page.getByText(/\+\d+ more provider\/region groups/)).toHaveCount(0);
  await expect(page.getByText(/Hidden outside this settings context/i)).toHaveCount(0);
  await expect(page.getByText(/Installation defaults require/i)).toHaveCount(0);
}

async function screenshotDefaultPoolScope(
  page: Page,
  heading: string,
  namePrefix: string,
  suffix: string
) {
  await screenshot(page, `${namePrefix}-${suffix}`);
  await screenshotNearHeading(page, heading, `${namePrefix}-focused-${suffix}`);
  await screenshotNearHeading(page, 'Active Sources', `${namePrefix}-details-${suffix}`);
}

async function removeAshHilCandidates(page: Page, editHeading: string, screenshotName: string) {
  await page.getByRole('button', { name: 'Edit' }).click();
  await expect(page.getByRole('heading', { name: editHeading })).toBeVisible();
  await page.getByRole('button', { name: /Remove Hetzner ash cpx31/ }).click();
  await page.getByRole('button', { name: /Remove Hetzner hil ccx33/ }).click();
  await screenshotNearHeading(page, editHeading, screenshotName);
  await page.getByLabel('Filter provider').selectOption('hetzner');
  await page.getByLabel('Filter region or location').fill('hil');
  await page.getByLabel('Minimum vCPU').fill('8');
  await page.getByLabel('Minimum RAM in GB').fill('32');
  await page.getByLabel('Maximum monthly price').fill('250');
  await page.getByLabel('Filter availability').selectOption('stale');
  await expect(page.getByText('1 matching offering across 1 region.')).toBeVisible();
  await expect(page.getByText('Stale catalog data').first()).toBeVisible();
  await screenshotSectionNearHeading(page, 'Catalog filters', `${screenshotName}-catalog-filters`);
  await expect(page.getByRole('button', { name: /Add Hetzner hil ccx33/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Stale' }).first()).toBeDisabled();
  await page
    .getByRole('heading', { name: 'Add instances from catalog' })
    .evaluate((element) => element.scrollIntoView({ block: 'start', inline: 'nearest' }));
  await screenshotNearHeading(
    page,
    'Add instances from catalog',
    `${screenshotName}-catalog-results`
  );
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText(/34 allowed · 2 removed\/disabled/)).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Removed or disabled instances' })).toBeVisible();
  await expect(page.getByText(/Hetzner · Ashburn \(ash\)/).first()).toBeVisible();
  await expect(page.getByText(/Hetzner · Hillsboro \(hil\)/).first()).toBeVisible();
  await assertNoOverflow(page);
}

test.describe('Default capacity pool scope surfaces', () => {
  test('user settings surface renders stressed user default pool without overflow', async ({
    page,
  }, testInfo) => {
    await setupUserPoolMocks(page);
    await page.goto('/settings/infrastructure');

    const suffix = getProjectSuffix(testInfo.project.name);
    await expectStressedDefaultPool(page, 'Your Infrastructure Compute Pool', 'user');
    await screenshotDefaultPoolScope(
      page,
      'Your Infrastructure Compute Pool',
      'default-capacity-pools-user',
      suffix
    );
    await removeAshHilCandidates(
      page,
      'Edit user default',
      `default-capacity-pools-user-edit-${suffix}`
    );
  });

  test('admin surface renders stressed installation default pool without overflow', async ({
    page,
  }, testInfo) => {
    await setupInstallationPoolMocks(page);
    await page.goto('/admin/infrastructure');

    const suffix = getProjectSuffix(testInfo.project.name);
    await expectStressedDefaultPool(
      page,
      'Installation Infrastructure Compute Pool',
      'installation'
    );
    await screenshotDefaultPoolScope(
      page,
      'Installation Infrastructure Compute Pool',
      'default-capacity-pools-installation',
      suffix
    );
    await removeAshHilCandidates(
      page,
      'Edit installation default',
      `default-capacity-pools-installation-edit-${suffix}`
    );
  });
});
