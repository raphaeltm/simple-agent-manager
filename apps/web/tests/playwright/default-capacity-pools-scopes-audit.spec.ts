import { expect, type Page, test } from '@playwright/test';

import {
  applyMockCapacityDefaultsUpdate,
  assertNoClippedOverflow,
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
const REMOVE_TARGETS = [
  { location: 'ash', sku: 'hcx-ash-4vcpu-8gb' },
  { location: 'hil', sku: 'hcx-hil-8vcpu-16gb' },
] as const;

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

function providerForIndex(index: number) {
  const providers = ['hetzner', 'scaleway', 'gcp', 'vultr', 'digitalocean', 'upcloud'];
  return index < 6 ? 'hetzner' : providers[index % providers.length];
}

function locationForIndex(scope: 'user' | 'installation', index: number) {
  const visibleLocations = ['fsn1', 'nbg1', 'hel1', 'ash', 'hil', 'sin'];
  if (index === 35) {
    return `region-with-a-deliberately-long-location-name-${scope}-${LONG_MARKER}`;
  }
  return visibleLocations[index] ?? `${scope}-region-${index}`;
}

function skuForIndex(index: number) {
  if (index === 3) return REMOVE_TARGETS[0].sku;
  if (index === 4) return REMOVE_TARGETS[1].sku;
  if (index === 35) {
    return `provider-native-sku-with-a-deliberately-long-name-${LONG_MARKER}`;
  }
  const shape = index % 5 === 0 ? 'dedicated' : 'shared';
  return `${providerForIndex(index)}-${shape}-${index + 1}vcpu-${(index % 8) + 4}gb`;
}

function vcpuForIndex(index: number) {
  if (index === 3) return 4;
  if (index === 4) return 8;
  return (index % 12) + 1;
}

function memoryMbForIndex(index: number) {
  if (index === 3) return 8192;
  if (index === 4) return 16_384;
  return ((index % 16) + 4) * 1024;
}

function diskGbForIndex(index: number) {
  return index % 7 === 0 ? 0 : (index + 1) * 20;
}

function priceForIndex(index: number) {
  if (index === 11) return null;
  if (index === 17) return '€499.99/mo';
  if (index % 6 === 0) return '~€0.024/hr';
  return `€${(3.5 + index * 2.71).toFixed(2)}/mo`;
}

function catalogAvailabilityForIndex(index: number) {
  if (index === 13) return { available: false, stale: false, status: 'provider capacity unavailable' };
  if (index === 21) return { available: true, stale: true, status: 'last-known catalog row' };
  return { available: true, stale: false, status: null };
}

function capacityCandidate(scope: 'user' | 'installation', index: number) {
  const price = priceForIndex(index);
  return {
    id: `${scope}-candidate-${index}`,
    poolId: `${scope}-default-pool`,
    capacitySourceId: `${scope}-source-${index % 6}`,
    provider: providerForIndex(index),
    location: locationForIndex(scope, index),
    workloadRole: 'workspace',
    runtime: index % 5 === 0 ? 'cf-container' : 'vm',
    machineClass: index % 4 === 0 ? 'dedicated-vm' : 'shared-vm',
    machineSize: index % 3 === 0 ? 'small' : index % 3 === 1 ? 'medium' : 'large',
    providerInstanceType: skuForIndex(index),
    providerInstanceVcpuCount: vcpuForIndex(index),
    providerInstanceMemoryMb: memoryMbForIndex(index),
    providerInstanceDiskGb: diskGbForIndex(index),
    providerInstancePriceDisplay: price,
    providerInstancePriceCurrency: price ? 'EUR' : null,
    providerInstancePriceMonthlyCents:
      price && price.includes('/mo')
        ? Math.round(Number(price.replace(/[^0-9.]/g, '')) * 100)
        : null,
    providerInstancePriceHourlyMicros:
      price && price.includes('/hr')
        ? Math.round(Number(price.replace(/[^0-9.]/g, '')) * 1_000_000)
        : null,
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
          ? `Personal infrastructure compute pool with very long owner-managed name — ${LONG_MARKER}`
          : `SAM installation infrastructure fallback pool with very long admin-managed name — ${LONG_MARKER}`,
      isDefault: true,
      revision: 7,
      status: 'active',
      strategy: scope === 'user' ? 'smallest-fit' : 'pack',
      exhaustionPolicy: 'queue',
      createdAt: TIMESTAMP,
      updatedAt: TIMESTAMP,
    },
    sources: [
      {
        id: `${scope}-source-0`,
        scope,
        ownerUserId: scope === 'user' ? 'pool-user' : null,
        ownerProjectId: null,
        sourceKind: 'cloud-provider-credential',
        provider: 'hetzner',
        credentialSource: scope === 'user' ? 'user' : 'platform',
        credentialId: scope === 'user' ? 'credential-user-cloud-long-id' : null,
        platformCredentialId: scope === 'installation' ? 'platform-credential-long-id' : null,
        credentialReference:
          scope === 'user'
            ? `credentials:user-cloud-reference-${LONG_MARKER}`
            : `platform_credentials:platform-cloud-reference-${LONG_MARKER}`,
        credentialVersion: 1787875200000,
        externalSourceRef: null,
        status: 'active',
        createdAt: TIMESTAMP,
        updatedAt: TIMESTAMP,
      },
    ],
    candidates,
    activeCandidateCount: candidates.length,
  };
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

function catalogResponse(scope: 'user' | 'installation') {
  const candidates = Array.from({ length: 36 }, (_, index) => capacityCandidate(scope, index));
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
      locations: [...new Set(providerCandidates.map((candidate) => candidate.location))].map(
        (location) => ({
          id: location,
          name: location.includes('region-with-a-deliberately-long-location-name')
            ? location
            : `${location.toUpperCase()} provider region`,
          country: location === 'ash' || location === 'hil' ? 'US' : 'EU',
        })
      ),
      sizes: {
        small: { type: `${provider}-legacy-compat-a`, price: '€3.99/mo', vcpu: 2, ramGb: 4, storageGb: 40 },
        medium: { type: `${provider}-legacy-compat-b`, price: '€12.99/mo', vcpu: 4, ramGb: 8, storageGb: 120 },
        large: { type: `${provider}-legacy-compat-c`, price: '€49.99/mo', vcpu: 8, ramGb: 32, storageGb: 240 },
      },
      offerings: [
        ...providerCandidates.map((candidate, index) => {
          const availability = catalogAvailabilityForIndex(index);
          return {
            sku: candidate.providerInstanceType,
            location: candidate.location,
            locationName: candidate.location.includes('region-with-a-deliberately-long-location-name')
              ? candidate.location
              : `${candidate.location.toUpperCase()} provider region`,
            country: candidate.location === 'ash' || candidate.location === 'hil' ? 'US' : 'EU',
            vcpu: candidate.providerInstanceVcpuCount,
            memoryMb: candidate.providerInstanceMemoryMb,
            diskGb: candidate.providerInstanceDiskGb,
            price: candidate.providerInstancePriceDisplay,
            available: availability.available,
            stale: availability.stale,
            status: availability.status,
          };
        }),
        {
          sku: `catalog-only-ultra-gpu-offering-${LONG_MARKER}`,
          location: 'catalog-only-region',
          locationName: `Catalog Only Region ${LONG_MARKER}`,
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

async function setupCommonMocks(
  page: Page,
  authUser: unknown,
  scope: 'user' | 'installation'
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
    if (path === '/api/providers/catalog') return respond(200, catalogResponse(scope));
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
        name: `Hetzner personal credential with a long visible label ${LONG_MARKER}`,
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
  await expect(page.getByText(/36 allowed/).first()).toBeVisible();
  await expect(
    page.getByText(new RegExp(`region-with-a-deliberately-long-location-name-${scope}`))
  ).toBeVisible();
  await expect(page.getByText('Price unavailable')).toBeVisible();
  await expect(page.getByText('€499.99/mo')).toBeVisible();
  await expect(page.getByText(/Hidden outside this settings context/i)).toHaveCount(0);
  await expect(page.getByText(/Installation defaults require/i)).toHaveCount(0);
  await expect(page.getByText(/Small candidate|Medium candidate|Large candidate/)).toHaveCount(0);
}

async function screenshotDefaultPoolScope(
  page: Page,
  heading: string,
  namePrefix: string,
  suffix: string
) {
  await screenshot(page, `${namePrefix}-${suffix}`);
  await screenshotNearHeading(page, heading, `${namePrefix}-focused-${suffix}`);
  await screenshotSectionNearHeading(page, heading, `${namePrefix}-section-${suffix}`);
  await screenshotNearHeading(page, 'Active Sources', `${namePrefix}-details-${suffix}`);
}

async function removeTargetOfferings(page: Page, editHeading: string, screenshotName: string) {
  await page.getByRole('button', { name: 'Edit' }).click();
  await expect(page.getByRole('heading', { name: editHeading })).toBeVisible();
  await page.getByRole('button', { name: `Remove Hetzner ${REMOVE_TARGETS[0].location} ${REMOVE_TARGETS[0].sku}` }).click();
  await page.getByRole('button', { name: `Remove Hetzner ${REMOVE_TARGETS[1].location} ${REMOVE_TARGETS[1].sku}` }).click();
  await expect(page.getByText(/34 allowed · 2 removed\/disabled/)).toBeVisible();
  await expect(page.getByText('Removed or disabled instances')).toBeVisible();
  await screenshotNearHeading(page, editHeading, screenshotName);
  await screenshotNearHeading(page, 'Removed or disabled instances', `${screenshotName}-removed`);
  await screenshotNearHeading(page, 'Catalog filters', `${screenshotName}-catalog`);
  await screenshotNearHeading(
    page,
    'Add instances from catalog',
    `${screenshotName}-catalog-results`
  );
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText(/34 allowed · 2 removed\/disabled/)).toBeVisible();
  await expect(page.getByText('Removed').first()).toBeVisible();
  await assertNoOverflow(page);
  await assertNoClippedOverflow(page);
}

test.describe('Default capacity pool scope surfaces', () => {
  test('user Infrastructure surface renders stressed user pool without overflow', async ({
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
    await removeTargetOfferings(
      page,
      'Edit user default',
      `default-capacity-pools-user-edit-${suffix}`
    );
  });

  test('admin Infrastructure surface renders stressed installation pool without overflow', async ({
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
    await removeTargetOfferings(
      page,
      'Edit installation default',
      `default-capacity-pools-installation-edit-${suffix}`
    );
  });
});
